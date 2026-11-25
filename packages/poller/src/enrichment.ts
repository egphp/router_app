import type Database from 'better-sqlite3';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import {
  PiiSessionSanitizer,
  categorizeByName,
  computeDeviceBehaviorVector,
  cosineSimilarity,
  embedTexts64,
  findRandomizedMacMatch,
  isAiReady,
  isLocallyAdministeredMac,
  lookupOui,
  profileDeviceBehavior,
  resolveGeminiApiKey,
} from '@tenda/shared';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

const RECHECK_INTERVAL_MS = 24 * 3600 * 1000;
const PROCESS_INTERVAL_MS = 2500;
const SYSLOG_CLUSTER_INTERVAL_MS = 60_000;

interface QueueRow {
  mac: string;
  ip: string | null;
  hostname: string | null;
  router_remark: string | null;
  vendor: string | null;
  category: string | null;
}

interface EnrichmentResult {
  vendor: string | null;
  device_type: string | null;
  os_guess: string | null;
  reverse_dns: string | null;
  fingerprint: string;
}

export class EnrichmentWorker {
  private timer: NodeJS.Timeout | null = null;
  private clusterTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private clusterBusy = false;
  private lastClusterSyslogTs = 0;
  private lastClusterUdpId = 0;
  private upsert: Database.Statement;
  private getNext: Database.Statement;
  private backfillDeviceStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.upsert = db.prepare(`
      INSERT INTO device_enrichment (mac, vendor, device_type, os_guess, reverse_dns, fingerprint, last_check, next_check, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(mac) DO UPDATE SET
        vendor      = excluded.vendor,
        device_type = excluded.device_type,
        os_guess    = excluded.os_guess,
        reverse_dns = excluded.reverse_dns,
        fingerprint = excluded.fingerprint,
        last_check  = excluded.last_check,
        next_check  = excluded.next_check,
        attempts    = device_enrichment.attempts + 1
    `);

    this.getNext = db.prepare(`
      SELECT
        d.mac,
        (SELECT ip FROM samples_raw WHERE mac = d.mac AND ip IS NOT NULL ORDER BY ts DESC LIMIT 1) AS ip,
        d.hostname,
        d.router_remark,
        d.vendor,
        d.category
      FROM devices d
      LEFT JOIN device_enrichment e ON e.mac = d.mac
      WHERE e.next_check IS NULL OR e.next_check < ?
      ORDER BY COALESCE(e.last_check, 0) ASC
      LIMIT 1
    `);

    this.backfillDeviceStmt = db.prepare(`
      UPDATE devices
      SET vendor = CASE
            WHEN vendor IS NULL OR TRIM(vendor) = '' OR LOWER(TRIM(vendor)) = 'unknown'
            THEN COALESCE(?, vendor)
            ELSE vendor
          END,
          category = CASE
            WHEN category IS NULL OR TRIM(category) = '' OR LOWER(TRIM(category)) = 'unknown'
            THEN COALESCE(?, category)
            ELSE category
          END,
          updated_at = ?
      WHERE mac = ?
    `);
  }

  start(): void {
    if (this.timer) return;
    log.info('enrichment worker started', { intervalMs: PROCESS_INTERVAL_MS });
    this.timer = setInterval(() => {
      void this.tick().catch((e) => log.warn('enrichment tick failed', String(e)));
    }, PROCESS_INTERVAL_MS);
    this.clusterTimer = setInterval(() => {
      void this.clusterSyslogTick().catch((e) => log.debug('syslog cluster tick skipped', String(e)));
    }, SYSLOG_CLUSTER_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.clusterTimer) {
      clearInterval(this.clusterTimer);
      this.clusterTimer = null;
    }
  }

  async tick(now = Date.now()): Promise<boolean> {
    if (this.busy) return false;
    const row = this.getNext.get(now) as QueueRow | undefined;
    if (!row) return false;
    this.busy = true;
    try {
      const result = await this.enrichOne(row, now);
      this.upsert.run(
        row.mac,
        result.vendor,
        result.device_type,
        result.os_guess,
        result.reverse_dns,
        result.fingerprint,
        now,
        now + RECHECK_INTERVAL_MS,
      );
      this.backfillDeviceStmt.run(result.vendor, result.device_type, now, row.mac);
      await this.updateBehavioralAiProfile(row, result, now);
      log.debug('enriched device', { mac: row.mac, type: result.device_type, dns: result.reverse_dns });
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async enrichOne(row: QueueRow, now: number): Promise<EnrichmentResult> {
    const oui = lookupOui(row.mac);
    const existingVendorClean =
      row.vendor && row.vendor.trim() && row.vendor.trim().toLowerCase() !== 'unknown' ? row.vendor : null;
    const vendor = existingVendorClean ?? (oui.vendor !== 'Unknown' ? oui.vendor : null);
    const reverseDns = row.ip ? await reverseLookupCrossPlatform(row.ip) : null;
    const { type, os } = this.classify(row.hostname, row.router_remark, vendor, reverseDns, oui.category ?? null);
    const fingerprint = JSON.stringify({
      hostname: row.hostname,
      vendor,
      ip: row.ip,
      reverse_dns: reverseDns,
      randomized_mac: isLocallyAdministeredMac(row.mac),
      classified_at: now,
    });
    return { vendor, device_type: type, os_guess: os, reverse_dns: reverseDns, fingerprint };
  }

  private async updateBehavioralAiProfile(row: QueueRow, heur: EnrichmentResult, now: number): Promise<void> {
    if (!hasTable(this.db, 'ai_device_profiles')) return;
    const vec = computeDeviceBehaviorVector(this.db, row.mac, now);
    const randMatch = findRandomizedMacMatch(this.db, row.mac, vec, now);

    let suggestedLabel: string | null = null;
    let inferredCategory: string | null = heur.device_type ?? row.category ?? null;
    let osGuess: string | null = heur.os_guess;
    let rationaleAr: string | null = randMatch
      ? `يتطابق سلوكياً بنسبة ${Math.round(randMatch.similarity * 100)}% مع جهاز سابق يستخدم MAC عشوائي.`
      : null;

    if (isAiReady(this.db, 'profiler') && (!inferredCategory || inferredCategory === 'unknown' || !osGuess)) {
      const { apiKey } = resolveGeminiApiKey(this.db);
      if (apiKey) {
        try {
          const sanitizer = new PiiSessionSanitizer(this.db);
          const radioSummary = this.db
            .prepare(`
              SELECT connection_kind, wifi_band, AVG(wifi_rssi_dbm) AS avg_rssi,
                     AVG(sessions) AS avg_sessions, MAX(down_speed_bps) AS peak_down, MAX(up_speed_bps) AS peak_up
              FROM samples_raw
              WHERE mac = ? AND ts >= ?
            `)
            .get(row.mac, now - 48 * 3600_000) as Record<string, unknown> | undefined;

          const features = sanitizer.sanitizeValue({
            vendor: heur.vendor ?? 'Unknown',
            randomizedMac: isLocallyAdministeredMac(row.mac),
            heuristicType: heur.device_type,
            heuristicOs: heur.os_guess,
            radio: radioSummary ?? {},
          });
          const aiProfile = await profileDeviceBehavior(apiKey, JSON.stringify(features));
          suggestedLabel = sanitizer.detokenizeText(aiProfile.suggestedLabel);
          if (aiProfile.inferredCategory && aiProfile.inferredCategory !== 'unknown') {
            inferredCategory = aiProfile.inferredCategory;
            this.backfillDeviceStmt.run(heur.vendor, inferredCategory, now, row.mac);
          }
          if (aiProfile.osGuess && aiProfile.osGuess !== 'Unknown OS') {
            osGuess = aiProfile.osGuess;
          }
          if (aiProfile.rationaleAr) {
            rationaleAr = sanitizer.detokenizeText(aiProfile.rationaleAr);
          }
        } catch (e) {
          log.debug('ai behavioral profile skipped', String(e));
        }
      }
    }

    this.db
      .prepare(`
        INSERT INTO ai_device_profiles (
          mac, suggested_label, inferred_category, os_guess,
          randomized_match_mac, randomized_similarity, rationale_ar, behavior_vector_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mac) DO UPDATE SET
          suggested_label = COALESCE(excluded.suggested_label, ai_device_profiles.suggested_label),
          inferred_category = COALESCE(excluded.inferred_category, ai_device_profiles.inferred_category),
          os_guess = COALESCE(excluded.os_guess, ai_device_profiles.os_guess),
          randomized_match_mac = excluded.randomized_match_mac,
          randomized_similarity = excluded.randomized_similarity,
          rationale_ar = COALESCE(excluded.rationale_ar, ai_device_profiles.rationale_ar),
          behavior_vector_json = excluded.behavior_vector_json,
          updated_at = excluded.updated_at
      `)
      .run(
        row.mac,
        suggestedLabel,
        inferredCategory,
        osGuess,
        randMatch?.matchedMac ?? null,
        randMatch?.similarity ?? null,
        rationaleAr,
        JSON.stringify(vec),
        now,
      );
  }

  /**
   * Semantic Router Log Clustering (`gemini-embedding-2` 64-D + deterministic trigram fallback).
   * Compresses thousands of repetitive syslog/attack lines into clean incident clusters in `ai_syslog_clusters`.
   */
  async clusterSyslogTick(now = Date.now()): Promise<number> {
    if (this.clusterBusy || !hasTable(this.db, 'ai_syslog_clusters')) return 0;
    this.clusterBusy = true;
    try {
      const lines: Array<{ ts: number; message: string; source: 'syslog' | 'udp' }> = [];
      if (hasTable(this.db, 'router_syslog')) {
        const rows = this.db
          .prepare(`SELECT ts, message FROM router_syslog WHERE ts > ? ORDER BY ts ASC LIMIT 250`)
          .all(this.lastClusterSyslogTs || now - 24 * 3600_000) as Array<{ ts: number; message: string }>;
        for (const r of rows) {
          lines.push({ ts: r.ts, message: r.message, source: 'syslog' });
          this.lastClusterSyslogTs = Math.max(this.lastClusterSyslogTs, r.ts);
        }
      }
      if (hasTable(this.db, 'router_log')) {
        const rows = this.db
          .prepare(`SELECT id, ts, message FROM router_log WHERE id > ? ORDER BY id ASC LIMIT 250`)
          .all(this.lastClusterUdpId) as Array<{ id: number; ts: number; message: string }>;
        for (const r of rows) {
          lines.push({ ts: r.ts, message: r.message, source: 'udp' });
          this.lastClusterUdpId = Math.max(this.lastClusterUdpId, r.id);
        }
      }
      if (lines.length === 0) return 0;

      // Group lines by structural template first so we embed at most N unique templates
      const grouped = new Map<
        string,
        { template: string; sample: string; count: number; firstTs: number; lastTs: number; severity: string }
      >();
      for (const l of lines) {
        const tpl = normalizeLogTemplate(l.message);
        const existing = grouped.get(tpl);
        const sev = inferLogSeverity(l.message);
        if (existing) {
          existing.count += 1;
          existing.firstTs = Math.min(existing.firstTs, l.ts);
          existing.lastTs = Math.max(existing.lastTs, l.ts);
        } else {
          grouped.set(tpl, {
            template: tpl,
            sample: l.message.slice(0, 240),
            count: 1,
            firstTs: l.ts,
            lastTs: l.ts,
            severity: sev,
          });
        }
      }

      const templates = [...grouped.values()].slice(0, 25);
      const { apiKey } = isAiReady(this.db, 'security') ? resolveGeminiApiKey(this.db) : { apiKey: null };
      const vectors = await embedTexts64(
        apiKey,
        templates.map((t) => t.template),
      );

      const existingClusters = this.db
        .prepare(`SELECT cluster_key, embedding_json FROM ai_syslog_clusters ORDER BY last_seen DESC LIMIT 60`)
        .all() as Array<{ cluster_key: string; embedding_json: string | null }>;

      const upsertCluster = this.db.prepare(`
        INSERT INTO ai_syslog_clusters (
          cluster_key, sample_message, summary_ar, severity, line_count, embedding_json, first_seen, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cluster_key) DO UPDATE SET
          line_count = ai_syslog_clusters.line_count + excluded.line_count,
          last_seen = MAX(ai_syslog_clusters.last_seen, excluded.last_seen),
          severity = CASE
            WHEN excluded.severity = 'critical' OR ai_syslog_clusters.severity = 'critical' THEN 'critical'
            WHEN excluded.severity = 'warn' OR ai_syslog_clusters.severity = 'warn' THEN 'warn'
            ELSE ai_syslog_clusters.severity
          END
      `);

      let mergedCount = 0;
      templates.forEach((item, idx) => {
        const vec = vectors[idx] ?? [];
        let targetKey = item.template.slice(0, 96);
        for (const ex of existingClusters) {
          if (!ex.embedding_json) continue;
          try {
            const exVec = JSON.parse(ex.embedding_json) as number[];
            if (cosineSimilarity(vec, exVec) >= 0.91) {
              targetKey = ex.cluster_key;
              break;
            }
          } catch {}
        }
        upsertCluster.run(
          targetKey,
          item.sample,
          summarizeTemplateArabic(item.template),
          item.severity,
          item.count,
          JSON.stringify(vec),
          item.firstTs,
          item.lastTs,
        );
        mergedCount += 1;
      });
      return mergedCount;
    } finally {
      this.clusterBusy = false;
    }
  }

  private classify(
    hostname: string | null,
    remark: string | null,
    vendor: string | null,
    reverseDns: string | null,
    ouiCategory: string | null,
  ): { type: string | null; os: string | null } {
    const name = `${hostname ?? ''} ${remark ?? ''} ${reverseDns ?? ''}`.toLowerCase();
    const v = (vendor ?? '').toLowerCase();
    const byName = categorizeByName(name);

    if (v.includes('apple') || /iphone|ipad|macbook|mac-studio|imac|mac mini|airpods|apple-tv/.test(name)) {
      if (/iphone|ip-?hone/.test(name)) return { type: 'phone', os: 'iOS' };
      if (/ipad/.test(name)) return { type: 'tablet', os: 'iPadOS' };
      if (/watch/.test(name)) return { type: 'watch', os: 'watchOS' };
      if (/tv/.test(name)) return { type: 'tv', os: 'tvOS' };
      if (/airpods|homepod/.test(name)) return { type: 'iot', os: 'Apple Audio' };
      return { type: byName ?? 'computer', os: 'macOS / iOS' };
    }
    if (v.includes('hikvision') || v.includes('dahua') || v.includes('reolink') || v.includes('ezviz') || byName === 'camera') {
      return { type: 'camera', os: 'Embedded NVR/IPC' };
    }
    if (v.includes('samsung') || /galaxy|sm-[a-z0-9]/.test(name)) {
      if (/-tv|qled|smart-tv|tizen/.test(name)) return { type: 'tv', os: 'Tizen' };
      return { type: 'phone', os: 'Android' };
    }
    if (v.includes('xiaomi') || v.includes('huawei') || v.includes('oppo') || v.includes('oneplus') || v.includes('realme') || v.includes('vivo')) {
      return { type: byName ?? 'phone', os: 'Android' };
    }
    if (/lg-tv|webos|chromecast|fire-tv|roku|shield-tv|bravia/.test(name)) {
      return { type: 'tv', os: 'Smart TV OS' };
    }
    if (v.includes('tenda') || v.includes('tp-link') || v.includes('mikrotik') || v.includes('ubiquiti')) {
      return { type: byName ?? 'router', os: 'Router Firmware' };
    }
    if (v.includes('epson') || v.includes('hp') || v.includes('canon') || v.includes('brother') || byName === 'printer') {
      return { type: 'printer', os: 'Printer Firmware' };
    }
    if (v.includes('espressif') || v.includes('tuya') || v.includes('shelly') || v.includes('sonoff') || /esp_|esp32|tuya|smart-/.test(name)) {
      return { type: 'iot', os: 'RTOS / Embedded' };
    }
    if (v.includes('nintendo')) return { type: 'console', os: 'Switch' };
    if (v.includes('sony') && /playstation|ps[345]/.test(name)) return { type: 'console', os: 'PlayStation' };
    if (v.includes('microsoft') && /xbox/.test(name)) return { type: 'console', os: 'Xbox' };
    if (/desktop|laptop|workstation|pc-|win-/.test(name)) return { type: 'computer', os: 'Windows' };
    if (/ubuntu|debian|arch|fedora|proxmox|ppeto|raspberry/.test(name)) return { type: byName ?? 'computer', os: 'Linux' };
    return { type: byName ?? ouiCategory ?? null, os: null };
  }
}

/**
 * Cross-platform safe reverse DNS lookup (Node `dns.promises.reverse` -> macOS `dscacheutil` -> Linux `getent`).
 * Never invokes a shell.
 */
export async function reverseLookupCrossPlatform(ip: string): Promise<string | null> {
  const cleanIp = ip.trim();
  if (!net.isIP(cleanIp)) return null;

  // 1. Standard PTR lookup with 400ms timeout
  try {
    const ptr = await Promise.race([
      dns.reverse(cleanIp),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 400)),
    ]);
    if (Array.isArray(ptr) && ptr[0] && ptr[0] !== cleanIp) {
      return ptr[0].replace(/\.$/, '');
    }
  } catch {
    // Fall through to OS resolver cache
  }

  // 2. macOS mDNS / Directory Services cache (`dscacheutil`)
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('dscacheutil', ['-q', 'host', '-a', 'ip_address', cleanIp], {
        timeout: 450,
      });
      const m = stdout.match(/^\s*name:\s*(\S+)/m);
      if (m?.[1] && m[1] !== cleanIp) {
        return m[1].replace(/\.$/, '');
      }
    } catch {
      return null;
    }
  } else if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('getent', ['hosts', cleanIp], { timeout: 450 });
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] !== cleanIp) {
        return parts[1]!;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function hasTable(db: Database.Database, name: string): boolean {
  const r = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
    | { ok: number }
    | undefined;
  return Boolean(r?.ok);
}

function normalizeLogTemplate(msg: string): string {
  return msg
    .trim()
    .toLowerCase()
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/g, '<mac>')
    .replace(/\b\d+\b/g, '<n>')
    .slice(0, 120);
}

function inferLogSeverity(msg: string): 'info' | 'warn' | 'critical' {
  const m = msg.toLowerCase();
  if (/ddos|flood|spoof|fail.*auth|bruteforce/.test(m)) return 'critical';
  if (/attack|drop|conflict|disconnect|timeout|reject/.test(m)) return 'warn';
  return 'info';
}

function summarizeTemplateArabic(tpl: string): string {
  if (tpl.includes('arp') && tpl.includes('attack')) {
    return 'تكرار رسائل حماية ARP من جهاز على الشبكة المحلية';
  }
  if (tpl.includes('ddos') || tpl.includes('udp_attack')) {
    return 'نشاط حزم UDP/DDoS مرصود من جدار حماية الراوتر';
  }
  if (tpl.includes('login')) {
    return 'عمليات تسجيل دخول إلى واجهة إدارة الراوتر';
  }
  if (tpl.includes('dhcp')) {
    return 'توزيع وتجديد عناوين DHCP للأجهزة المتصلة';
  }
  if (tpl.includes('pppoe') || tpl.includes('wan')) {
    return 'أحداث حالة اتصال خطوط الإنترنت (WAN1 / WAN2)';
  }
  return 'نمط سجلات نظام متكرر من الراوتر';
}
