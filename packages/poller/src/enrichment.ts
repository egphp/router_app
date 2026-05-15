import type Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { lookupOui } from '@tenda/shared';
import { log } from './logger.js';

/**
 * Per-device enrichment queue. For each known device, periodically:
 *  1. OUI vendor lookup (instant, from bundled prefix list)
 *  2. Reverse DNS / mDNS hostname (`getent hosts <ip>`, ~50ms)
 *  3. Heuristic device-type + OS guess (from hostname + vendor patterns)
 *
 * Rate-limited: processes at most one device every 2 seconds so it never
 * spikes CPU. State stored in device_enrichment table so we don't re-process
 * stale entries on every poll cycle. Devices are re-checked every 24h.
 */

const RECHECK_INTERVAL_MS = 24 * 3600 * 1000;
const PROCESS_INTERVAL_MS = 2000; // 1 device every 2 seconds → ~30/min, ~720/hour

interface QueueRow {
  mac: string;
  ip: string | null;
  hostname: string | null;
  vendor: string | null;
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
  private upsert: Database.Statement;
  private getNext: Database.Statement;

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
    // Pick devices that have never been enriched, OR whose enrichment is stale.
    this.getNext = db.prepare(`
      SELECT d.mac, d.ip, d.hostname, d.vendor
      FROM devices d
      LEFT JOIN device_enrichment e ON e.mac = d.mac
      WHERE e.next_check IS NULL OR e.next_check < ?
      ORDER BY COALESCE(e.last_check, 0) ASC
      LIMIT 1
    `);
  }

  start(): void {
    if (this.timer) return;
    log.info('enrichment worker started', { intervalMs: PROCESS_INTERVAL_MS });
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { log.warn('enrichment tick failed', String(e)); }
    }, PROCESS_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private tick(): void {
    const now = Date.now();
    const row = this.getNext.get(now) as QueueRow | undefined;
    if (!row) return;
    const result = this.enrichOne(row);
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
    log.debug('enriched device', { mac: row.mac, type: result.device_type, dns: result.reverse_dns });
  }

  private enrichOne(row: QueueRow): EnrichmentResult {
    const vendor = row.vendor ?? lookupOui(row.mac).vendor;
    const reverseDns = row.ip ? this.reverseLookup(row.ip) : null;
    const { type, os } = this.classify(row.hostname, vendor, reverseDns);
    const fingerprint = JSON.stringify({
      hostname: row.hostname,
      vendor,
      ip: row.ip,
      reverse_dns: reverseDns,
      classified_at: Date.now(),
    });
    return { vendor, device_type: type, os_guess: os, reverse_dns: reverseDns, fingerprint };
  }

  /** Cheap DNS-only reverse lookup (no mDNS — too slow + needs avahi). 100ms cap. */
  private reverseLookup(ip: string): string | null {
    try {
      const out = execSync(`getent hosts ${ip} 2>/dev/null | awk '{print $2}'`, {
        encoding: 'utf-8',
        timeout: 500,
      }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  /** Heuristic device-type + OS guess based on hostname patterns + vendor. */
  private classify(hostname: string | null, vendor: string | null, reverseDns: string | null): { type: string | null; os: string | null } {
    const name = `${hostname ?? ''} ${reverseDns ?? ''}`.toLowerCase();
    const v = (vendor ?? '').toLowerCase();
    // Apple ecosystem
    if (v.includes('apple') || /iphone|ipad|macbook|mac-studio|imac|mac mini|airpods|apple-tv/.test(name)) {
      if (/iphone|ip-?hone/.test(name)) return { type: 'phone', os: 'iOS' };
      if (/ipad/.test(name)) return { type: 'tablet', os: 'iPadOS' };
      if (/watch/.test(name)) return { type: 'watch', os: 'watchOS' };
      if (/tv/.test(name)) return { type: 'tv', os: 'tvOS' };
      if (/airpods/.test(name)) return { type: 'iot', os: null };
      return { type: 'computer', os: 'macOS' };
    }
    if (v.includes('samsung') || v.includes('sm-')) {
      if (/galaxy|sm-[a-z]/.test(name)) return { type: 'phone', os: 'Android' };
      if (/-tv|qled|smart-tv/.test(name)) return { type: 'tv', os: 'Tizen' };
      return { type: 'phone', os: 'Android' };
    }
    if (v.includes('xiaomi') || v.includes('huawei') || v.includes('oppo') || v.includes('oneplus') || v.includes('redmi') || v.includes('realme')) {
      return { type: 'phone', os: 'Android' };
    }
    // TVs / streaming
    if (/lg-tv|chromecast|fire-tv|roku|shield-tv/.test(name)) return { type: 'tv', os: null };
    // Routers / AP
    if (v.includes('tenda') || v.includes('tp-link') || v.includes('mikrotik') || v.includes('ubiquiti')) return { type: 'router', os: null };
    // Printers
    if (v.includes('hp') || v.includes('canon') || v.includes('brother') || /printer|laserjet/.test(name)) return { type: 'printer', os: null };
    // IoT-leaning
    if (v.includes('espressif') || v.includes('bouffalo') || v.includes('texas instruments') || /esp_|esp32|tuya|smart-/.test(name)) return { type: 'iot', os: null };
    // Game consoles
    if (v.includes('nintendo')) return { type: 'console', os: 'Switch' };
    if (v.includes('sony') && /playstation|ps[345]/.test(name)) return { type: 'console', os: 'PlayStation' };
    if (v.includes('microsoft') && /xbox/.test(name)) return { type: 'console', os: 'Xbox' };
    // Computers
    if (/desktop|laptop|workstation|pc-|win-/.test(name)) return { type: 'computer', os: 'Windows' };
    return { type: null, os: null };
  }
}
