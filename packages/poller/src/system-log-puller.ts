import type Database from 'better-sqlite3';
import type { RouterClient } from './router-client.js';
import { insertAlertIfAllowed, sendAttackPush } from '@tenda/shared';
import { log } from './logger.js';

interface LogEntry {
  ID: number;
  sysLogTime: string;
  sysLogType: number;
  sysLogMsg: string;
}

/**
 * Pulls /goform/module?getSystemLog& periodically and persists new rows. This is the
 * router's *own* event log (Attack Log, system events) — separate from the syslog the
 * router can be configured to push out via UDP.
 *
 * Parses entries like:
 *   "detect 506 ARP attack from 192.168.0.227/5A:C2:A6:04:63:7E"
 *   "detect 1 DDOS (udp_attack) attack from 192.168.0.132/48:E1:5C:7D:C8:60"
 *   "[system] 192.168.0.7 login"
 */
export class SystemLogPuller {
  private insert: Database.Statement;
  private findExisting: Database.Statement;
  private insertAlert: Database.Statement;
  private knownIds = new Set<number>();
  private notifiedAttacks = new Map<string, number>();

  constructor(private readonly db: Database.Database, private readonly router: RouterClient) {
    this.insert = db.prepare(`
      INSERT OR REPLACE INTO router_syslog (router_id, ts, log_type, message, attacker_ip, attacker_mac, attack_kind, attack_count, fetched_at)
      VALUES (@id, @ts, @log_type, @message, @attacker_ip, @attacker_mac, @attack_kind, @attack_count, @fetched_at)
    `);
    this.findExisting = db.prepare(`SELECT router_id FROM router_syslog WHERE router_id = ?`);
    this.insertAlert = db.prepare(`INSERT INTO alerts (kind, mac, payload, created_at) VALUES (?, ?, ?, ?)`);
    // Warm the dedupe cache
    const existing = db.prepare(`SELECT router_id FROM router_syslog`).all() as Array<{ router_id: number }>;
    for (const e of existing) this.knownIds.add(e.router_id);
  }

  async pull(): Promise<{ added: number; attacks: number }> {
    const entries = await this.router.getSystemLog(0); // all log types
    let added = 0;
    let attacks = 0;
    const now = Date.now();
    const attackPushes: Array<{
      mac: string | null;
      ip: string | null;
      kind: string | null;
      count: number | null;
      message: string;
    }> = [];

    const txn = this.db.transaction(() => {
      for (const e of entries) {
        if (this.knownIds.has(e.ID)) continue;
        const parsed = parseLogEntry(e);
        const ts = parseRouterDate(e.sysLogTime);
        this.insert.run({
          id: e.ID,
          ts,
          log_type: e.sysLogType,
          message: e.sysLogMsg,
          attacker_ip: parsed.attacker_ip,
          attacker_mac: parsed.attacker_mac,
          attack_kind: parsed.attack_kind,
          attack_count: parsed.attack_count,
          fetched_at: now,
        });
        this.knownIds.add(e.ID);
        added++;

        // Surface attacks with > 50 events in a single message as alerts, dedupe per attacker-mac+kind+day
        if (parsed.attack_kind && parsed.attack_count && parsed.attack_count >= 50 && parsed.attacker_mac) {
          const dayBucket = Math.floor(ts / (24 * 60 * 60 * 1000));
          const key = `${parsed.attacker_mac}|${parsed.attack_kind}|${dayBucket}`;
          if (!this.notifiedAttacks.has(key)) {
            this.notifiedAttacks.set(key, now);
            const alert = insertAlertIfAllowed(
              this.db,
              'attack',
              parsed.attacker_mac,
              {
                rule: 'router_detected_attack',
                severity: parsed.attack_count >= 500 ? 'critical' : 'warn',
                kind: parsed.attack_kind,
                count: parsed.attack_count,
                ip: parsed.attacker_ip,
                mac: parsed.attacker_mac,
                router_time: e.sysLogTime,
                router_message: e.sysLogMsg,
              },
              ts,
            );
            if (alert.inserted) {
              attacks++;
              attackPushes.push({
                mac: parsed.attacker_mac,
                ip: parsed.attacker_ip,
                kind: parsed.attack_kind,
                count: parsed.attack_count,
                message: e.sysLogMsg,
              });
            }
          }
        }
      }
    });
    txn();

    for (const alert of attackPushes) {
      try {
        const result = await sendAttackPush(this.db, alert);
        log.warn('attack push result', { mac: alert.mac, kind: alert.kind, ...result });
      } catch (error) {
        log.warn('attack push failed', String(error));
      }
    }

    if (added > 0) log.info('system-log-puller', { added, attacks });
    return { added, attacks };
  }
}

interface ParsedAttack {
  attacker_ip: string | null;
  attacker_mac: string | null;
  attack_kind: string | null;
  attack_count: number | null;
}

export function parseLogEntry(e: LogEntry): ParsedAttack {
  const msg = e.sysLogMsg;
  // ARP attacks: "detect 506 ARP attack from 192.168.0.227/5A:C2:A6:04:63:7E"
  // DDoS:       "detect 1 DDOS (udp_attack) attack from 192.168.0.132/48:E1:5C:7D:C8:60"
  const m = msg.match(/detect\s+(\d+)\s+(\S+(?:\s+\([^)]+\))?)\s+attack\s+from\s+([\d.]+)\/([A-Fa-f0-9:]+)/);
  if (m) {
    return {
      attack_count: Number(m[1]),
      attack_kind: m[2].replace(/\s+\(([^)]+)\)/, ':$1'),
      attacker_ip: m[3],
      attacker_mac: m[4].toUpperCase(),
    };
  }
  return { attacker_ip: null, attacker_mac: null, attack_kind: null, attack_count: null };
}

function parseRouterDate(s: string): number {
  // "2026-05-15 08:55:39"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return Date.now();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}
