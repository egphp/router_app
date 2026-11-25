import type Database from 'better-sqlite3';
import {
  insertAlertIfAllowed,
  isAiReady,
  resolveGeminiApiKey,
  triageDomainsWithDecisionApi,
} from '@tenda/shared';
import { classifyHost, extractHosts } from './nsfw-domains.js';
import { log } from './logger.js';

export interface NsfwPushCandidate {
  mac: string | null;
  ip: string | null;
  domain: string;
  category: string;
}

interface PendingUnknownDomainSighting {
  domain: string;
  ts: number;
  mac: string | null;
  ip: string | null;
  excerpt: string;
}

const BENIGN_ROOT_ALLOWLIST = new Set([
  'apple.com',
  'icloud.com',
  'mzstatic.com',
  'cdn-apple.com',
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googlevideo.com',
  'youtube.com',
  'ytimg.com',
  'cloudflare.com',
  'cloudflare-dns.com',
  'microsoft.com',
  'windows.com',
  'windowsupdate.com',
  'live.com',
  'office.com',
  'amazonaws.com',
  'cloudfront.net',
  'akamaihd.net',
  'akamaized.net',
  'fastly.net',
  'whatsapp.net',
  'whatsapp.com',
  'facebook.com',
  'fbcdn.net',
  'instagram.com',
  'cdninstagram.com',
  'tiktok.com',
  'tiktokcdn.com',
  'netflix.com',
  'nflxvideo.net',
  'telegram.org',
  'snapchat.com',
  'sc-cdn.net',
  'github.com',
  'npmjs.org',
]);

export class NsfwScanner {
  private insertHit: Database.Statement;
  private insertPushEvent: Database.Statement;
  private lastSyslogTs: number;
  private lastUdpLogId = 0;
  private hasRouterLogTable = false;
  private hasAiDomainCacheTable = false;
  private pendingUnknown = new Map<string, PendingUnknownDomainSighting>();
  private aiTriageRunning = false;

  constructor(private db: Database.Database) {
    this.insertHit = db.prepare(`
      INSERT INTO nsfw_hits (ts, source_mac, source_ip, domain, category, raw_excerpt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.insertPushEvent = db.prepare(`
      INSERT OR IGNORE INTO nsfw_push_events (event_key, source_mac, source_ip, domain, category, first_seen, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const last = db.prepare(`SELECT MAX(ts) as t FROM nsfw_hits`).get() as { t: number | null };
    const baselineTs = last.t ?? Date.now() - 24 * 3600 * 1000;
    this.lastSyslogTs = baselineTs;

    this.refreshOptionalSchema(baselineTs);
  }

  private refreshOptionalSchema(baselineTs?: number): void {
    try {
      const tables = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('router_log', 'ai_domain_cache')`)
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((t) => t.name));
      const hadUdp = this.hasRouterLogTable;
      this.hasRouterLogTable = names.has('router_log');
      this.hasAiDomainCacheTable = names.has('ai_domain_cache');
      if (this.hasRouterLogTable && !hadUdp && baselineTs !== undefined) {
        const maxUdp = this.db
          .prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM router_log WHERE ts <= ?`)
          .get(baselineTs) as { max_id: number };
        this.lastUdpLogId = Number(maxUdp?.max_id ?? 0);
      }
    } catch {
      this.hasRouterLogTable = false;
      this.hasAiDomainCacheTable = false;
    }
  }

  isEnabled(): boolean {
    try {
      const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'nsfw_detection'`).get() as
        | { value: string }
        | undefined;
      if (!row) return true;
      return row.value !== 'off';
    } catch {
      return true;
    }
  }

  private loadCustomBlockedDomains(): Array<{ domain: string; category: string }> {
    try {
      const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'nsfw_extra_domains'`).get() as
        | { value: string }
        | undefined;
      if (!row?.value) return [];
      return row.value
        .split(/[\n,;]+/)
        .map((s) => normalizeDomain(s))
        .filter(Boolean)
        .map((domain) => ({ domain, category: 'custom-blocked' }));
    } catch {
      return [];
    }
  }

  private lookupAiCachedDomain(host: string): { domain: string; category: string } | 'safe_cached' | null {
    if (!this.hasAiDomainCacheTable) return null;
    const h = normalizeDomain(host);
    if (!h) return null;
    const candidates = [h];
    const parts = h.split('.');
    if (parts.length > 2) {
      candidates.push(parts.slice(-2).join('.'));
    }
    try {
      for (const cand of candidates) {
        const row = this.db
          .prepare(`SELECT domain, category, confidence FROM ai_domain_cache WHERE domain = ?`)
          .get(cand) as { domain: string; category: string; confidence: number } | undefined;
        if (!row) continue;
        if (row.category === 'adult' && Number(row.confidence ?? 0) >= 0.92) {
          return { domain: row.domain, category: 'ai-adult' };
        }
        return 'safe_cached';
      }
    } catch {
      return null;
    }
    return null;
  }

  private recordHit(
    ts: number,
    now: number,
    rawMac: string | null,
    rawIp: string | null,
    domain: string,
    category: string,
    rawMessage: string,
    pushCandidates: NsfwPushCandidate[],
  ): boolean {
    try {
      this.insertHit.run(ts, rawMac ?? null, rawIp ?? null, domain, category, rawMessage.slice(0, 200));
      const mac = normalizeMac(rawMac);
      const ip = normalizeIp(rawIp);
      const eventKey = nsfwEventKey(ts, mac, ip, domain);
      const event = this.insertPushEvent.run(eventKey, mac || null, ip || null, domain, category, ts, now);
      if (event.changes > 0) {
        try {
          insertAlertIfAllowed(
            this.db,
            'nsfw',
            mac || null,
            {
              rule: category.includes('malware') ? 'suspicious_domain_visit' : 'adult_content_visit',
              mac: mac || null,
              ip: ip || null,
              domain,
              category,
              message: `${mac || ip || 'Unknown device'} opened ${domain}`,
            },
            ts,
          );
        } catch {
          // Minimal test DBs may omit alerts table
        }
        pushCandidates.push({ mac: mac || null, ip: ip || null, domain, category });
      }
      return true;
    } catch {
      return false;
    }
  }

  private inspectMessage(
    ts: number,
    now: number,
    message: string,
    rawMac: string | null,
    rawIp: string | null,
    extraList: Array<{ domain: string; category: string }>,
    pushCandidates: NsfwPushCandidate[],
  ): number {
    let added = 0;
    const hosts = extractHosts(message);
    for (const h of hosts) {
      const clean = normalizeDomain(h);
      if (!clean) continue;

      let hit = classifyHost(clean);
      if (!hit && extraList.length > 0) {
        for (const custom of extraList) {
          if (clean === custom.domain || clean.endsWith('.' + custom.domain)) {
            hit = custom;
            break;
          }
        }
      }

      if (!hit) {
        const aiCached = this.lookupAiCachedDomain(clean);
        if (aiCached && aiCached !== 'safe_cached') {
          hit = aiCached;
        } else if (
          aiCached === null &&
          !isBenignAllowlisted(clean) &&
          !isMediaCdnStreamExcerpt(message) &&
          this.pendingUnknown.size < 120
        ) {
          const root = registrableRoot(clean);
          if (root && !this.pendingUnknown.has(root)) {
            this.pendingUnknown.set(root, {
              domain: root,
              ts,
              mac: rawMac,
              ip: rawIp,
              excerpt: message.slice(0, 200),
            });
          }
        }
      }

      if (!hit) continue;
      if (this.recordHit(ts, now, rawMac, rawIp, hit.domain, hit.category, message, pushCandidates)) {
        added += 1;
      }
    }
    return added;
  }

  scan(now: number): { hits: number; pushCandidates: NsfwPushCandidate[] } {
    if (!this.isEnabled()) return { hits: 0, pushCandidates: [] };
    this.refreshOptionalSchema();
    const extraList = this.loadCustomBlockedDomains();
    let added = 0;
    const pushCandidates: NsfwPushCandidate[] = [];

    // 1. Scan router_syslog (/goform/module?getSystemLog)
    const syslogRows = this.db
      .prepare(
        `SELECT ts, message, attacker_ip, attacker_mac FROM router_syslog WHERE ts > ? AND ts <= ? ORDER BY ts ASC LIMIT 5000`,
      )
      .all(this.lastSyslogTs, now) as Array<{
      ts: number;
      message: string;
      attacker_ip: string | null;
      attacker_mac: string | null;
    }>;

    for (const r of syslogRows) {
      const inferred = extractClientHintsFromLog(r.message, r.attacker_mac, r.attacker_ip);
      added += this.inspectMessage(r.ts, now, r.message, inferred.mac, inferred.ip, extraList, pushCandidates);
    }
    if (syslogRows.length > 0) {
      this.lastSyslogTs = syslogRows[syslogRows.length - 1]!.ts;
    }

    // 2. Scan UDP router_log (when present — where Tenda pushes URL/DNS audit lines!)
    if (this.hasRouterLogTable) {
      try {
        const udpRows = this.db
          .prepare(
            `SELECT id, ts, message, src_ip FROM router_log WHERE id > ? AND ts <= ? ORDER BY id ASC LIMIT 5000`,
          )
          .all(this.lastUdpLogId, now) as Array<{
          id: number;
          ts: number;
          message: string;
          src_ip: string | null;
        }>;
        for (const r of udpRows) {
          const inferred = extractClientHintsFromLog(r.message, null, null);
          added += this.inspectMessage(r.ts, now, r.message, inferred.mac, inferred.ip, extraList, pushCandidates);
          this.lastUdpLogId = r.id;
        }
      } catch (e) {
        log.debug('nsfw scanner: router_log scan skipped', String(e));
      }
    }

    if (added > 0) {
      log.warn('nsfw scanner: found hits', { added, pushCandidates: pushCandidates.length, period: 'recent' });
    }
    return { hits: added, pushCandidates };
  }

  /**
   * Zero-PII Cloud Domain Triage (`gemini-decision-1`, 0 output tokens).
   * Sends ONLY anonymous root domain strings (never MACs, IPs, or timestamps) and caches verdicts in `ai_domain_cache`.
   */
  async tickAiDomainTriage(now = Date.now()): Promise<{
    checked: number;
    flagged: number;
    pushCandidates: NsfwPushCandidate[];
  }> {
    if (this.aiTriageRunning || this.pendingUnknown.size === 0 || !this.isEnabled()) {
      return { checked: 0, flagged: 0, pushCandidates: [] };
    }
    this.refreshOptionalSchema();
    if (!this.hasAiDomainCacheTable || !isAiReady(this.db, 'domain')) {
      return { checked: 0, flagged: 0, pushCandidates: [] };
    }
    const { apiKey } = resolveGeminiApiKey(this.db);
    if (!apiKey) return { checked: 0, flagged: 0, pushCandidates: [] };

    this.aiTriageRunning = true;
    const pushCandidates: NsfwPushCandidate[] = [];
    try {
      const batch = [...this.pendingUnknown.values()].slice(0, 15);
      for (const item of batch) this.pendingUnknown.delete(item.domain);

      const anonymousDomains = batch.map((b) => b.domain);
      const decisions = await triageDomainsWithDecisionApi(apiKey, anonymousDomains);
      const upsertCache = this.db.prepare(`
        INSERT INTO ai_domain_cache (domain, category, confidence, source, checked_at)
        VALUES (?, ?, ?, 'gemini-decision-1', ?)
        ON CONFLICT(domain) DO UPDATE SET
          category = excluded.category,
          confidence = excluded.confidence,
          checked_at = excluded.checked_at
      `);

      const byDomain = new Map(batch.map((b) => [b.domain, b]));
      let flagged = 0;

      for (const dec of decisions) {
        upsertCache.run(dec.domain, dec.category, dec.confidence, now);
        // STRICT ADULT-ONLY RULE: Never flag malware_phishing/gambling/unknown CDN domains as Adult Content!
        if (dec.category === 'adult' && dec.confidence >= 0.92) {
          const sighting = byDomain.get(dec.domain);
          if (sighting) {
            const ok = this.recordHit(
              sighting.ts,
              now,
              sighting.mac,
              sighting.ip,
              dec.domain,
              'ai-adult',
              sighting.excerpt,
              pushCandidates,
            );
            if (ok) flagged += 1;
          }
        }
      }
      return { checked: decisions.length, flagged, pushCandidates };
    } catch (e) {
      log.debug('nsfw ai domain triage skipped', String(e));
      return { checked: 0, flagged: 0, pushCandidates: [] };
    } finally {
      this.aiTriageRunning = false;
    }
  }
}

function normalizeDomain(raw: string): string {
  const clean = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/:\d+$/, '');
  if (!clean || clean.endsWith('.local') || clean.endsWith('.lan') || clean.endsWith('.arpa')) return '';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(clean)) return '';
  return clean;
}

function registrableRoot(domain: string): string {
  const parts = domain.split('.').filter(Boolean);
  if (parts.length <= 2) return domain;
  const twoPartTlds = new Set(['co.uk', 'com.eg', 'edu.eg', 'gov.eg', 'org.uk', 'com.au', 'co.jp']);
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function isBenignAllowlisted(domain: string): boolean {
  const root = registrableRoot(domain);
  return BENIGN_ROOT_ALLOWLIST.has(domain) || BENIGN_ROOT_ALLOWLIST.has(root);
}

/**
 * Recognizes IPTV / HLS / VOD video CDN chunk URLs (e.g. `/live/...m3u8`, `/hls/...ts`, `/series/...mkv`)
 * logged by Tenda HTTP URL audit so rotating `.xyz` video CDN edge hosts are never misclassified as adult sites.
 */
function isMediaCdnStreamExcerpt(message: string): boolean {
  return /(?:\/live\/[^\s]*\.m3u8|\/hls\/[^\s]*\.ts|\/(?:series|movie|vod)\/[^\s]*\.(?:mkv|mp4|ts|avi)|:8080\/hls\/)/i.test(
    message,
  );
}

function extractClientHintsFromLog(
  message: string,
  fallbackMac: string | null,
  fallbackIp: string | null,
): { mac: string | null; ip: string | null } {
  let mac = normalizeMac(fallbackMac);
  let ip = normalizeIp(fallbackIp);
  if (!mac) {
    const m = message.match(/\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\b/);
    if (m) mac = normalizeMac(m[1]);
  }
  if (!ip) {
    const m = message.match(/\b((?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/);
    if (m) ip = normalizeIp(m[1]);
  }
  return { mac: mac || null, ip: ip || null };
}

function normalizeMac(value: string | null | undefined): string {
  if (!value) return '';
  const mac = value.trim().toUpperCase();
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? mac : '';
}

function normalizeIp(value: string | null | undefined): string {
  if (!value) return '';
  const ip = value.trim();
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : '';
}

function nsfwEventKey(ts: number, mac: string, ip: string, domain: string): string {
  const source = mac || ip || 'unknown';
  const bucket = Math.floor(ts / (60 * 60 * 1000));
  return `${source}|${domain}|${bucket}`;
}
