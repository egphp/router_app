import dgram from 'node:dgram';
import type Database from 'better-sqlite3';
import { log } from './logger.js';

/**
 * Minimal RFC 3164 syslog receiver. The Tenda router can be configured to send
 * audit logs (URL visits, MAC events, auth, etc.) to a remote syslog server. We
 * listen on UDP, parse the line, and persist to `router_log`.
 *
 * Default port 514 needs root on macOS/Linux. We listen on 5140 by default and
 * provide a setup snippet that uses pf/iptables to forward 514 → 5140.
 */

export class SyslogServer {
  private sock: dgram.Socket | null = null;
  private insertLog: Database.Statement;

  constructor(private readonly db: Database.Database, private readonly port: number, private readonly bindAddr = '0.0.0.0') {
    // Migration is applied lazily — see migrations/003_syslog.sql
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS router_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        priority    INTEGER,
        facility    INTEGER,
        severity    INTEGER,
        host        TEXT,
        tag         TEXT,
        message     TEXT NOT NULL,
        src_ip      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_router_log_ts ON router_log(ts);
    `);
    this.insertLog = db.prepare(`
      INSERT INTO router_log (ts, priority, facility, severity, host, tag, message, src_ip)
      VALUES (@ts, @priority, @facility, @severity, @host, @tag, @message, @src_ip)
    `);
  }

  start(): void {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const text = msg.toString('utf-8');
        const parsed = parseSyslog(text);
        this.insertLog.run({
          ts: parsed.ts ?? Date.now(),
          priority: parsed.priority,
          facility: parsed.facility,
          severity: parsed.severity,
          host: parsed.host,
          tag: parsed.tag,
          message: parsed.message,
          src_ip: rinfo.address,
        });
      } catch (err) {
        log.warn('syslog: parse error', { err: String(err), msg: msg.toString('utf-8').slice(0, 200) });
      }
    });
    sock.on('error', (err) => log.error('syslog: socket error', String(err)));
    sock.on('listening', () => {
      const addr = sock.address();
      log.info('syslog: listening', { addr });
    });
    try {
      sock.bind(this.port, this.bindAddr);
    } catch (err) {
      log.warn('syslog: bind failed, log capture disabled', { port: this.port, err: String(err) });
      return;
    }
    this.sock = sock;
  }

  stop(): void {
    if (this.sock) {
      try { this.sock.close(); } catch {}
      this.sock = null;
    }
  }
}

interface ParsedSyslog {
  ts: number | null;
  priority: number | null;
  facility: number | null;
  severity: number | null;
  host: string | null;
  tag: string | null;
  message: string;
}

export function parseSyslog(raw: string): ParsedSyslog {
  // RFC 3164: <pri>timestamp host tag: message
  const m = raw.match(/^<(\d+)>(.*)$/s);
  let priority: number | null = null;
  let body = raw;
  if (m) {
    priority = Number(m[1]);
    body = m[2];
  }
  const facility = priority !== null ? Math.floor(priority / 8) : null;
  const severity = priority !== null ? priority % 8 : null;
  const ts = parseEmbeddedRouterTime(body);

  // Try to parse "MMM dd HH:mm:ss host tag: message"
  const m2 = body.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s*(.*)$/s);
  if (m2) {
    return { ts, priority, facility, severity, host: m2[2], tag: m2[3], message: m2[4].trim() };
  }
  // Try "host tag: msg"
  const m3 = body.match(/^(\S+)\s+([A-Za-z0-9_.-]+):\s*(.*)$/s);
  if (m3) {
    return { ts, priority, facility, severity, host: m3[1], tag: m3[2], message: m3[3].trim() };
  }
  return { ts, priority, facility, severity, host: null, tag: null, message: body.trim() };
}

function parseEmbeddedRouterTime(body: string): number | null {
  const match = body.match(/\btime:(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\b/);
  if (!match) return null;
  const ts = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  return Number.isFinite(ts) ? ts : null;
}
