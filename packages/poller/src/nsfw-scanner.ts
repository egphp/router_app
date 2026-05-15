import type Database from 'better-sqlite3';
import { classifyHost, extractHosts } from './nsfw-domains.js';
import { log } from './logger.js';

export class NsfwScanner {
  private insertHit: Database.Statement;
  private lastScanTs: number;

  constructor(private db: Database.Database) {
    this.insertHit = db.prepare(`
      INSERT INTO nsfw_hits (ts, source_mac, source_ip, domain, category, raw_excerpt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const last = db.prepare(`SELECT MAX(ts) as t FROM nsfw_hits`).get() as { t: number | null };
    this.lastScanTs = last.t ?? Date.now() - 24 * 3600 * 1000;
  }

  isEnabled(): boolean {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'nsfw_detection'`).get() as { value: string } | undefined;
    if (!row) return true; // default on
    return row.value !== 'off';
  }

  scan(now: number): { hits: number } {
    if (!this.isEnabled()) return { hits: 0 };
    // Pull recent syslog entries we haven't scanned yet
    const rows = this.db.prepare(
      `SELECT ts, message, attacker_ip, attacker_mac FROM router_syslog WHERE ts > ? AND ts <= ? ORDER BY ts ASC LIMIT 5000`
    ).all(this.lastScanTs, now) as Array<{ ts: number; message: string; attacker_ip: string | null; attacker_mac: string | null }>;
    let added = 0;
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
        } catch {
          // duplicate or schema error — skip
        }
      }
    }
    if (rows.length > 0) this.lastScanTs = rows[rows.length - 1].ts;
    if (added > 0) log.warn('nsfw scanner: found hits', { added, period: 'recent' });
    return { hits: added };
  }
}
