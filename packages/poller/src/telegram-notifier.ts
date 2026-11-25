import type Database from 'better-sqlite3';
import {
  PiiSessionSanitizer,
  buildNetworkLiveSnapshot,
  getAiSettings,
  isAiReady,
  resolveGeminiApiKey,
  runCopilotTurn,
  summarizeNetworkDigest,
  transcribeAudioCommand,
  type ProposedRouterAction,
} from '@tenda/shared';
import type { RouterClient } from './router-client.js';
import type { Sampler } from './sampler.js';
import { applyProposedRouterAction } from './ai-action-executor.js';
import { log } from './logger.js';

interface AlertRow {
  id: number;
  kind: string;
  mac: string | null;
  payload: string | null;
  created_at: number;
}

interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Upgraded Two-Way Telegram Network Agent:
 * 1. Outbound alerts with burst coalescing + inline router action buttons (Unlimited / HD / SD / WAN2).
 * 2. Inbound `getUpdates` restricted strictly to `chat.id === configuredChatId` supporting Arabic text & voice notes (`gemini-3.5-transcribe` -> `runCopilotTurn`).
 * 3. Scheduled Arabic Morning Brief.
 */
export class TelegramNotifier {
  private lastSentId = 0;
  private lastUpdateOffset = 0;
  private enabled = false;
  private botToken = '';
  private chatId = '';
  private findStmt: Database.Statement;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollingUpdates = false;
  private callbackActionMap = new Map<string, ProposedRouterAction>();

  constructor(
    private readonly db: Database.Database,
    private readonly router?: RouterClient,
    private readonly sampler?: Sampler,
  ) {
    this.refreshCredentials();
    this.findStmt = db.prepare(`
      SELECT id, kind, mac, payload, created_at FROM alerts
      WHERE id > ? AND dismissed_at IS NULL
        AND (kind IN ('outage', 'reboot', 'attack', 'wan_ip_changed', 'total_download_threshold')
             OR (kind = 'security' AND json_extract(payload, '$.severity') IN ('warn', 'critical'))
             OR (kind = 'new_device'))
      ORDER BY id ASC LIMIT 20
    `);
    const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM alerts`).get() as { m: number };
    this.lastSentId = max.m;

    if (this.enabled) log.info('telegram: two-way notifier enabled', { chatId: this.chatId });
    else log.info('telegram: notifier disabled (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set)');
  }

  private refreshCredentials(): void {
    const dbToken = this.readSetting('telegram_bot_token');
    const dbChat = this.readSetting('telegram_chat_id');
    this.botToken = (process.env.TELEGRAM_BOT_TOKEN || dbToken || '').trim();
    this.chatId = (process.env.TELEGRAM_CHAT_ID || dbChat || '').trim();
    this.enabled = Boolean(this.botToken && this.chatId);
  }

  startInteractiveLoop(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollUpdates().catch((e) => log.debug('telegram pollUpdates skipped', String(e)));
    }, 6_000);
  }

  stopInteractiveLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async tick(): Promise<void> {
    this.refreshCredentials();
    if (!this.enabled) return;

    await this.maybeSendMorningBrief().catch((e) => log.debug('morning brief skipped', String(e)));

    const rows = this.findStmt.all(this.lastSentId) as AlertRow[];
    if (rows.length === 0) return;

    // Coalesce burst of >= 4 alerts into a single structured digest so router reboot/reconnect storms never spam
    if (rows.length >= 4) {
      try {
        const digestText = await this.buildCoalescedDigest(rows);
        await this.send(digestText);
        this.lastSentId = rows[rows.length - 1]!.id;
        return;
      } catch (e) {
        log.warn('telegram: coalesced send error', String(e));
      }
    }

    for (const r of rows) {
      try {
        const { text, keyboard } = this.formatMessageWithActions(r);
        await this.send(text, keyboard);
        this.lastSentId = r.id;
      } catch (e) {
        log.warn('telegram: send error', String(e));
        break;
      }
    }
  }

  private async buildCoalescedDigest(rows: AlertRow[]): Promise<string> {
    if (isAiReady(this.db, 'brief')) {
      const { apiKey } = resolveGeminiApiKey(this.db);
      if (apiKey) {
        try {
          const sanitizer = new PiiSessionSanitizer(this.db);
          const sanitizedRows = sanitizer.sanitizeValue(
            rows.map((r) => ({
              kind: r.kind,
              mac: r.mac,
              payload: r.payload ? safeJson(r.payload) : null,
              at: new Date(r.created_at).toLocaleTimeString(),
            })),
          );
          const aiDigest = await summarizeNetworkDigest(apiKey, JSON.stringify(sanitizedRows), 'alert_coalesce');
          if (aiDigest) {
            return `📌 *ملخص دفعة تنبيهات مترابطة (${rows.length})*\n\n${sanitizer.detokenizeText(aiDigest)}`;
          }
        } catch {}
      }
    }
    const lines = rows.map((r) => `• ${this.formatMessageWithActions(r).text.split('\n')[0]}`);
    return `📌 *ملخص ${rows.length} تنبيهات متزامنة*\n${lines.join('\n')}`;
  }

  private async maybeSendMorningBrief(): Promise<void> {
    const cfg = getAiSettings(this.db);
    if (!cfg.morningBriefEnabled) return;
    const now = new Date();
    if (now.getHours() !== cfg.morningBriefHour) return;
    const dayKey = now.toISOString().slice(0, 10);
    const prevKey = this.readKv('ai.telegram.last_morning_brief_day');
    if (prevKey === dayKey) return;

    this.writeKv('ai.telegram.last_morning_brief_day', dayKey);
    const snap = buildNetworkLiveSnapshot(this.db, now.getTime());
    let text = '';

    if (cfg.configured && cfg.enabled) {
      const { apiKey } = resolveGeminiApiKey(this.db);
      if (apiKey) {
        try {
          const sanitizer = new PiiSessionSanitizer(this.db);
          const raw = await summarizeNetworkDigest(
            apiKey,
            JSON.stringify(sanitizer.sanitizeValue(snap)),
            'morning_brief',
          );
          if (raw) {
            text = `☀️ *تقرير الصباح الذكي للشبكة*\n\n${sanitizer.detokenizeText(raw)}`;
          }
        } catch {}
      }
    }

    if (!text) {
      const q = snap.quotaSummary as any;
      text =
        `☀️ *ملخص الشبكة الصباحي*\n` +
        `• الأجهزة المتصلة: ${(snap.routerState as any)?.online_count ?? 0}\n` +
        `• استهلاك الدورة: ${q.usedGb} GB (معدل ${q.dailyBurnGb} GB/يوم)\n` +
        `• المتبقي للتجديد: ${Math.ceil(q.daysRemainingInCycle)} يوم\n` +
        `• التنبيهات المفتوحة: ${snap.activeAlertsCount}`;
    }
    await this.send(text);
  }

  formatMessage(r: { kind: string; mac: string | null; payload: string | null; created_at: number }): string {
    return this.formatMessageWithActions({ id: 0, ...r }).text;
  }

  private formatMessageWithActions(r: AlertRow): { text: string; keyboard?: InlineButton[][] } {
    const p = r.payload ? safeJson(r.payload) : null;
    const when = new Date(r.created_at).toLocaleString();
    const mac = r.mac ? r.mac.toUpperCase() : null;

    switch (r.kind) {
      case 'new_device': {
        const autoReserve = p?.auto_reserved_ip ? `\n🔒 حجز IP تلقائي: \`${p.auto_reserved_ip}\`` : '';
        const autoCap =
          p?.auto_limited_down_kbs || p?.auto_limited_up_kbs
            ? `\n⚡ سقف SD احترازي: ↓ ${p?.auto_limited_down_kbs ?? 0} KB/s · ↑ ${p?.auto_limited_up_kbs ?? 0} KB/s`
            : '';
        // Include AI trust recommendation if already scored
        let aiHint = '';
        if (mac) {
          try {
            const prof = this.db
              .prepare(`SELECT recommended_qos_profile, rationale_ar FROM ai_device_profiles WHERE mac = ?`)
              .get(mac) as { recommended_qos_profile?: string; rationale_ar?: string } | undefined;
            if (prof?.rationale_ar) {
              aiHint = `\n🤖 توصية الذكاء الاصطناعي (${prof.recommended_qos_profile?.toUpperCase()}): ${prof.rationale_ar}`;
            }
          } catch {}
        }
        const keyboard = mac
          ? [
              [
                { text: '🔓 سرعة كاملة', callback_data: `qos|${mac}|0|0` },
                { text: '🎬 وضع HD', callback_data: `qos|${mac}|2048|512` },
              ],
              [
                { text: '🔒 إبقاء SD', callback_data: `qos|${mac}|256|64` },
                { text: '🌐 نقل إلى WAN2', callback_data: `wan|${mac}|2` },
              ],
            ]
          : undefined;
        return {
          text: `🔴 *جهاز جديد على الشبكة*\nMAC: \`${r.mac}\`\nName: ${p?.hostname || 'unknown'}\nIP: ${p?.ip || '?'}\nVendor: ${p?.vendor || '?'}${autoReserve}${autoCap}${aiHint}\n_${when}_`,
          keyboard,
        };
      }
      case 'outage':
        return { text: `⚠ *انقطاع الاتصال بالراوتر*\nReason: ${p?.reason || '?'}\n_${when}_` };
      case 'reboot':
        return { text: `🔄 *إعادة تشغيل الراوتر*\nUptime was: ${p?.uptimeBefore}s\n_${when}_` };
      case 'security': {
        const keyboard = mac
          ? [
              [
                { text: '🔒 عزل SD (256 KB/s)', callback_data: `qos|${mac}|256|64` },
                { text: '✓ تجاهل التنبيه', callback_data: `dis|${r.id}` },
              ],
            ]
          : [[{ text: '✓ تجاهل التنبيه', callback_data: `dis|${r.id}` }]];
        return {
          text: `🛡 *تنبيه أمني* (${p?.severity})\n${p?.message}\nMAC: \`${r.mac ?? 'N/A'}\`\n_${when}_`,
          keyboard,
        };
      }
      case 'attack':
        return {
          text: `🚨 *هجوم مرصود من الراوتر*\nKind: ${p?.kind}\nCount: ${p?.count}\nFrom: ${p?.ip} / \`${r.mac}\`\n_${when}_`,
        };
      case 'wan_ip_changed': {
        const hostTarget = p?.ddnsFqdn || p?.publicIp;
        const ddnsLine = p?.ddnsFqdn ? `\n🛡 DDNS: \`${p.ddnsFqdn}\`${p?.ddnsSynced ? ' (Synced)' : ''}` : '';
        const sshLine =
          p?.sshEnabled && hostTarget && p?.sshPort
            ? `\n🔑 SSH: \`ssh -p ${p.sshPort} ${p?.sshUser || 'michaeltawfik'}@${hostTarget}\``
            : '';
        return {
          text: `🌐 *تغيّر عنوان ${p?.wanName || 'WAN'} الخارجي*\nPrevious: \`${p?.previousIp || '?'}\`\nNew IP: \`${p?.publicIp || '?'}\`${ddnsLine}${sshLine}\n_${when}_`,
        };
      }
      case 'total_download_threshold':
        return { text: `📊 *تنبيه استهلاك الباقة*\n${p?.message || ''}\n_${when}_` };
      default:
        return { text: `[${r.kind}] ${p?.message || ''}\n_${when}_` };
    }
  }

  private async pollUpdates(): Promise<void> {
    this.refreshCredentials();
    if (!this.enabled || this.pollingUpdates) return;
    this.pollingUpdates = true;
    try {
      const offsetParam = this.lastUpdateOffset > 0 ? `&offset=${this.lastUpdateOffset}` : '';
      const r = await fetch(`https://api.telegram.org/bot${this.botToken}/getUpdates?timeout=0&limit=10${offsetParam}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return;
      const body = (await r.json()) as { ok?: boolean; result?: any[] };
      if (!body.ok || !Array.isArray(body.result) || body.result.length === 0) return;

      for (const upd of body.result) {
        this.lastUpdateOffset = Math.max(this.lastUpdateOffset, Number(upd.update_id ?? 0) + 1);

        // 1. Inline callback button press
        if (upd.callback_query) {
          const cq = upd.callback_query;
          const chatIdStr = String(cq.message?.chat?.id ?? '');
          if (chatIdStr !== this.chatId) continue; // Strict owner chat check!
          await this.handleCallbackQuery(String(cq.id), String(cq.data ?? ''));
          continue;
        }

        // 2. Text or Voice message
        const msg = upd.message;
        if (!msg) continue;
        if (String(msg.chat?.id ?? '') !== this.chatId) continue; // Strict owner chat check!

        if (typeof msg.text === 'string' && msg.text.trim()) {
          await this.handleIncomingUserPrompt(msg.text.trim());
        } else if (msg.voice?.file_id || msg.audio?.file_id) {
          await this.handleIncomingVoiceNote(String(msg.voice?.file_id ?? msg.audio?.file_id));
        }
      }
    } catch {
      // Network hiccups or another getUpdates consumer — retry quietly next tick
    } finally {
      this.pollingUpdates = false;
    }
  }

  private async handleCallbackQuery(callbackId: string, data: string): Promise<void> {
    if (!this.router) {
      await this.answerCallback(callbackId, 'التحكم بالراوتر غير متاح حالياً');
      return;
    }
    const parts = data.split('|');
    let action: Partial<ProposedRouterAction> | null = null;
    if (parts[0] === 'qos' && parts.length >= 4) {
      action = {
        kind: 'set_qos',
        mac: parts[1],
        downloadLimitKbs: Number(parts[2]),
        uploadLimitKbs: Number(parts[3]),
      };
    } else if (parts[0] === 'wan' && parts.length >= 3) {
      action = {
        kind: 'move_wan',
        mac: parts[1],
        wanPort: Number(parts[2]) === 2 ? 2 : 1,
      };
    } else if (parts[0] === 'dis' && parts.length >= 2) {
      action = {
        kind: 'dismiss_alert',
        alertId: Number(parts[1]),
      };
    } else if (parts[0] === 'act' && parts[1]) {
      action = this.callbackActionMap.get(parts[1]) ?? null;
    }

    if (!action) {
      await this.answerCallback(callbackId, 'انتهت صلاحية الزر');
      return;
    }

    const res = await applyProposedRouterAction(this.db, this.router, this.sampler, action);
    await this.answerCallback(callbackId, res.ok ? 'تم التنفيذ بنجاح ✓' : `تعذّر التنفيذ: ${res.error}`);
    if (res.ok) {
      await this.send(`✅ ${res.summaryAr}`);
    }
  }

  private async handleIncomingVoiceNote(fileId: string): Promise<void> {
    const { apiKey } = resolveGeminiApiKey(this.db);
    if (!apiKey) {
      await this.send('🎙 لتشغيل الأوامر الصوتية عبر Gemini 3.5 Transcribe أضف مفتاح `GEMINI_API_KEY` في صفحة الإعدادات.');
      return;
    }
    try {
      const fRes = await fetch(`https://api.telegram.org/bot${this.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, {
        signal: AbortSignal.timeout(8000),
      });
      const fJson = (await fRes.json()) as { ok?: boolean; result?: { file_path?: string } };
      const filePath = fJson.result?.file_path;
      if (!filePath) return;

      const dlRes = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`, {
        signal: AbortSignal.timeout(12_000),
      });
      if (!dlRes.ok) return;
      const arrBuf = await dlRes.arrayBuffer();
      const base64Audio = Buffer.from(arrBuf).toString('base64');
      const transcript = await transcribeAudioCommand(apiKey, base64Audio, 'audio/ogg');
      if (!transcript) {
        await this.send('🎙 لم أتمكن من سماع الرسالة الصوتية بوضوح، حاول مرة أخرى.');
        return;
      }
      await this.handleIncomingUserPrompt(transcript, `🎙 _"${transcript}"_\n\n`);
    } catch (e) {
      log.warn('telegram voice command failed', String(e));
    }
  }

  private async handleIncomingUserPrompt(prompt: string, prefix = ''): Promise<void> {
    const turn = await runCopilotTurn(this.db, {
      message: prompt.startsWith('/') ? prompt.replace(/^\//, '') : prompt,
      pageContext: { pathname: '/telegram' },
    });

    let keyboard: InlineButton[][] | undefined;
    if (turn.proposedActions.length > 0) {
      keyboard = turn.proposedActions.slice(0, 4).map((act) => {
        const shortKey = Math.random().toString(36).slice(2, 9);
        this.callbackActionMap.set(shortKey, act);
        if (this.callbackActionMap.size > 100) {
          const oldest = this.callbackActionMap.keys().next().value;
          if (oldest) this.callbackActionMap.delete(oldest);
        }
        return [{ text: `⚡ ${act.labelAr.slice(0, 42)}`, callback_data: `act|${shortKey}` }];
      });
    }

    await this.send(`${prefix}${turn.replyAr}`, keyboard);
  }

  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 180) }),
      signal: AbortSignal.timeout(6000),
    }).catch(() => {});
  }

  private async send(text: string, keyboard?: InlineButton[][]): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    };
    if (keyboard && keyboard.length > 0) {
      payload.reply_markup = { inline_keyboard: keyboard };
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      // Fallback without Markdown if special characters broke Telegram parser
      const fallbackPayload = { ...payload };
      delete fallbackPayload.parse_mode;
      const retry = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackPayload),
        signal: AbortSignal.timeout(10000),
      });
      if (!retry.ok) {
        const t = await retry.text();
        throw new Error(`telegram HTTP ${retry.status}: ${t.slice(0, 200)}`);
      }
    }
  }

  private readSetting(key: string): string | null {
    try {
      const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private readKv(key: string): string | null {
    try {
      const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private writeKv(key: string, value: string): void {
    try {
      this.db
        .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value);
    } catch {}
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
