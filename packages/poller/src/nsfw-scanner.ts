import type Database from 'better-sqlite3';
import { insertAlertIfAllowed } from '@tenda/shared';
import { classifyHost, extractHosts } from './nsfw-domains.js';
import { log } from './logger.js';

export interface NsfwPushCandidate {
  mac: string | null;
  ip: string | null;
  domain: string;
  category: string;
}

export class NsfwScanner {
  private insertHit: Database.Statement;
  private insertPushEvent: Database.Statement;
  private lastScanTs: number;

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
    this.lastScanTs = last.t ?? Date.now() - 24 * 3600 * 1000;
  }

  isEnabled(): boolean {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'nsfw_detection'`).get() as { value: string } | undefined;
    if (!row) return true; // default on
    return row.value !== 'off';
  }

  scan(now: number): { hits: number; pushCandidates: NsfwPushCandidate[] } {
    if (!this.isEnabled()) return { hits: 0, pushCandidates: [] };
    // Pull recent syslog entries we haven't scanned yet
    const rows = this.db.prepare(
      `SELECT ts, message, attacker_ip, attacker_mac FROM router_syslog WHERE ts > ? AND ts <= ? ORDER BY ts ASC LIMIT 5000`
    ).all(this.lastScanTs, now) as Array<{ ts: number; message: string; attacker_ip: string | null; attacker_mac: string | null }>;
    let added = 0;
    const pushCandidates: NsfwPushCandidate[] = [];
    for (const r of rows) {
      const hosts = extractHosts(r.message);
      for (const h of hosts) {
        const hit = classifyHost(h);
        if (!hit) continue;
        try {
          this.insertHit.run(
            r.ts, r.attacker_mac ?? null, r.attacker_ip ?? null, hit.domain, hit.category,
            r.message.slice(0, 200),
          );
          added += 1;
          const mac = normalizeMac(r.attacker_mac);
          const ip = normalizeIp(r.attacker_ip);
          const eventKey = nsfwEventKey(r.ts, mac, ip, hit.domain);
          const event = this.insertPushEvent.run(eventKey, mac || null, ip || null, hit.domain, hit.category, r.ts, now);
          if (event.changes > 0) {
            try {
              insertAlertIfAllowed(this.db, 'nsfw', mac || null, {
                rule: 'adult_content_visit',
                mac: mac || null,
                ip: ip || null,
                domain: hit.domain,
                category: hit.category,
                message: `${mac || ip || 'Unknown device'} opened ${hit.domain}`,
              }, r.ts);
            } catch {
              // Older test/minimal DBs may not have the alerts table; hit/push event still matter.
            }
            pushCandidates.push({ mac: mac || null, ip: ip || null, domain: hit.domain, category: hit.category });
          }
        } catch {
          // duplicate or schema error — skip
        }
      }
    }
    if (rows.length > 0) this.lastScanTs = rows[rows.length - 1].ts;
    if (added > 0) log.warn('nsfw scanner: found hits', { added, pushCandidates: pushCandidates.length, period: 'recent' });
    return { hits: added, pushCandidates };
  }
}

function normalizeMac(value: string | null): string {
  if (!value) return '';
  const mac = value.trim().toUpperCase();
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? mac : '';
}

function normalizeIp(value: string | null): string {
  if (!value) return '';
  const ip = value.trim();
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : '';
}

function nsfwEventKey(ts: number, mac: string, ip: string, domain: string): string {
  const source = mac || ip || 'unknown';
  const bucket = Math.floor(ts / (60 * 60 * 1000));
  return `${source}|${domain}|${bucket}`;
}
