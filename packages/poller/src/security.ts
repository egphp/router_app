import type Database from 'better-sqlite3';
import type { RouterDevice } from '@tenda/shared';
import { log } from './logger.js';

export interface SecurityCheck {
  rule: string;
  severity: 'info' | 'warn' | 'critical';
  mac: string | null;
  message: string;
  detail?: any;
}

/**
 * Heuristic security checks that run each cycle. We can't do real IDS without packet
 * inspection — these are pattern-based flags computed from the data we already have.
 */
export class SecurityScanner {
  private insertAlert: Database.Statement;
  private lastAlertByKey = new Map<string, number>();
  private knownLocallyAdministered = new Set<string>();

  constructor(private readonly db: Database.Database) {
    this.insertAlert = db.prepare(
      `INSERT INTO alerts (kind, mac, payload, created_at) VALUES (?, ?, ?, ?)`
    );
  }

  scan(now: number, devices: RouterDevice[]): SecurityCheck[] {
    const out: SecurityCheck[] = [];
    const onlineDevices = devices.filter((d) => d.hostOnlineStatus === 1) as any[];

    // 1. Connection-count spike (possible port scan / many sockets)
    for (const d of onlineDevices) {
      const conn = d.hostConnectCount ?? 0;
      if (conn >= 200) {
        out.push({
          rule: 'high_connection_count',
          severity: conn >= 500 ? 'critical' : 'warn',
          mac: d.hostMAC,
          message: `Device "${d.hostName || d.hostMAC}" has ${conn} concurrent connections`,
          detail: { connections: conn, ip: d.hostIP },
        });
      }
    }

    // 2. Sudden high upload speed (potential exfiltration / outbound DDoS)
    for (const d of onlineDevices) {
      const up = d.hostUploadSpeed ?? 0;
      if (up > 5 * 1024 * 1024) { // 5 MB/s sustained upload
        out.push({
          rule: 'high_upload',
          severity: up > 20 * 1024 * 1024 ? 'critical' : 'warn',
          mac: d.hostMAC,
          message: `Device "${d.hostName || d.hostMAC}" uploading at ${(up / 1024 / 1024).toFixed(1)} MB/s`,
          detail: { up_bps: up, ip: d.hostIP },
        });
      }
    }

    // 3. Locally-administered MAC = device with randomized/spoofed address.
    //    Single such device is normal (iOS/Android private MAC). Many such = suspicious.
    let randomMacCount = 0;
    for (const d of devices as any[]) {
      const first = parseInt((d.hostMAC || '00').slice(0, 2), 16);
      if (!Number.isNaN(first) && (first & 0x02)) {
        randomMacCount++;
        this.knownLocallyAdministered.add(d.hostMAC);
      }
    }
    if (randomMacCount >= 8) {
      out.push({
        rule: 'many_random_macs',
        severity: 'info',
        mac: null,
        message: `${randomMacCount} devices use randomized MAC addresses (normal for modern phones)`,
        detail: { count: randomMacCount },
      });
    }

    // 4. Same hostname on multiple MACs (cloning / impersonation)
    const byName = new Map<string, any[]>();
    for (const d of onlineDevices) {
      const n = (d.hostName || '').trim();
      if (!n) continue;
      const arr = byName.get(n) ?? [];
      arr.push(d);
      byName.set(n, arr);
    }
    for (const [name, arr] of byName.entries()) {
      if (arr.length >= 3 && !/^espressif|^esp_|^iphone$|^ipad$|^android$/i.test(name)) {
        out.push({
          rule: 'hostname_clones',
          severity: 'warn',
          mac: null,
          message: `${arr.length} devices share hostname "${name}"`,
          detail: { hostname: name, macs: arr.map((x) => x.hostMAC) },
        });
      }
    }

    // 5. Suspicious IP ranges (devices on the LAN but using non-DHCP-range IPs)
    for (const d of onlineDevices) {
      const ip = d.hostIP || '';
      if (ip && !/^192\.168\.0\./.test(ip)) {
        out.push({
          rule: 'out_of_subnet',
          severity: 'warn',
          mac: d.hostMAC,
          message: `Device "${d.hostName || d.hostMAC}" reports IP ${ip} outside the LAN subnet`,
          detail: { ip, mac: d.hostMAC },
        });
      }
    }

    // Persist (deduped: same rule+mac fires at most once per hour)
    const dedupeMs = 60 * 60 * 1000;
    for (const c of out) {
      const key = `${c.rule}|${c.mac ?? ''}`;
      const last = this.lastAlertByKey.get(key) ?? 0;
      if (now - last < dedupeMs) continue;
      this.lastAlertByKey.set(key, now);
      try {
        this.insertAlert.run(
          'security',
          c.mac,
          JSON.stringify({ rule: c.rule, severity: c.severity, message: c.message, detail: c.detail }),
          now,
        );
      } catch (e) {
        log.warn('failed to persist security alert', String(e));
      }
    }

    return out;
  }
}
