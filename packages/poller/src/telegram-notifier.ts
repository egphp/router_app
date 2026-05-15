import type Database from 'better-sqlite3';
import { log } from './logger.js';

/**
 * Push new high-severity alerts to a Telegram chat. Configured via env:
 *   TELEGRAM_BOT_TOKEN=123456:ABC...
 *   TELEGRAM_CHAT_ID=-1001234567890
 * If either is missing, the notifier is silently disabled.
 */
export class TelegramNotifier {
  private lastSentId = 0;
  private enabled = false;
  private botToken: string;
  private chatId: string;
  private findStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = !!this.botToken && !!this.chatId;
    this.findStmt = db.prepare(`
      SELECT id, kind, mac, payload, created_at FROM alerts
      WHERE id > ? AND dismissed_at IS NULL
        AND (kind IN ('outage', 'reboot', 'attack')
             OR (kind = 'security' AND json_extract(payload, '$.severity') IN ('warn', 'critical'))
             OR (kind = 'new_device'))
      ORDER BY id ASC LIMIT 20
    `);
    // Seed lastSentId so we don't spam on startup
    const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM alerts`).get() as { m: number };
    this.lastSentId = max.m;
    if (this.enabled) log.info('telegram: notifier enabled', { chatId: this.chatId });
    else log.info('telegram: notifier disabled (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set)');
  }

  async tick(): Promise<void> {
    if (!this.enabled) return;
    const rows = this.findStmt.all(this.lastSentId) as Array<{
      id: number; kind: string; mac: string | null; payload: string | null; created_at: number;
    }>;
    if (rows.length === 0) return;
    for (const r of rows) {
      try {
        const text = this.formatMessage(r);
        await this.send(text);
        this.lastSentId = r.id;
      } catch (e) {
        log.warn('telegram: send error', String(e));
        break; // retry next tick
      }
    }
  }

  private formatMessage(r: { kind: string; mac: string | null; payload: string | null; created_at: number }): string {
    const p = r.payload ? safeJson(r.payload) : null;
    const when = new Date(r.created_at).toLocaleString();
    switch (r.kind) {
      case 'new_device':
        return `🔴 *New device* on the LAN\nMAC: \`${r.mac}\`\nName: ${p?.hostname || 'unknown'}\nIP: ${p?.ip || '?'}\nVendor: ${p?.vendor || '?'}\n_${when}_`;
      case 'outage':
        return `⚠ *Router unreachable*\nReason: ${p?.reason || '?'}\n_${when}_`;
      case 'reboot':
        return `🔄 *Router rebooted*\nUptime was: ${p?.uptimeBefore}s\n_${when}_`;
      case 'security':
        return `🛡 *Security alert* (${p?.severity})\n${p?.message}\nMAC: \`${r.mac}\`\n_${when}_`;
      case 'attack':
        return `🚨 *Attack detected*\nKind: ${p?.kind}\nCount: ${p?.count}\nFrom: ${p?.ip} / \`${r.mac}\`\n_${when}_`;
      default:
        return `[${r.kind}] ${p?.message || ''}\n_${when}_`;
    }
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`telegram HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
  }
}

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
