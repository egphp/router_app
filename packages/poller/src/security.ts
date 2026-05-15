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
  private findRecentAlert: Database.Statement;
  private knownLocallyAdministered = new Set<string>();
  // After a user dismisses an alert we suppress the same rule+mac for this long.
  // Keeps the page from becoming spam when the underlying condition (e.g. Mac
  // Studio always has lots of connections) is permanent.
  private readonly DEDUPE_AFTER_DISMISS_MS = 24 * 60 * 60 * 1000;
  private readonly DEDUPE_DEFAULT_MS = 60 * 60 * 1000;

  constructor(private readonly db: Database.Database) {
    this.insertAlert = db.prepare(
      `INSERT INTO alerts (kind, mac, payload, created_at) VALUES (?, ?, ?, ?)`
    );
    // Find the most recent alert for this rule+mac and whether it was dismissed.
    this.findRecentAlert = db.prepare(`
      SELECT created_at, dismissed_at FROM alerts
      WHERE kind = 'security'
        AND (mac IS ? OR mac = ?)
        AND json_extract(payload, '$.rule') = ?
      ORDER BY id DESC LIMIT 1
    `);
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

    // 5. Suspicious IP ranges. Derive the LAN /24 dynamically from the majority
    // of devices so the rule works on any router (192.168.0.x, 192.168.5.x, 10.x.x.x...)
    const subnetCounts = new Map<string, number>();
    for (const d of onlineDevices) {
      const ip = d.hostIP || '';
      const m = ip.match(/^(\d+\.\d+\.\d+)\./);
      if (m) subnetCounts.set(m[1], (subnetCounts.get(m[1]) ?? 0) + 1);
    }
    const dominant = [...subnetCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] >= 3) {
      const lanPrefix = dominant[0] + '.';
      for (const d of onlineDevices) {
        const ip = d.hostIP || '';
        if (ip && !ip.startsWith(lanPrefix)) {
          out.push({
            rule: 'out_of_subnet',
            severity: 'warn',
            mac: d.hostMAC,
            message: `Device "${d.hostName || d.hostMAC}" reports IP ${ip} outside the LAN subnet (${dominant[0]}.x)`,
            detail: { ip, mac: d.hostMAC, lan: dominant[0] + '.0/24' },
          });
        }
      }
    }

    // Persist with smart dedupe: respect user-dismissed alerts for 24h to prevent
    // spam when the underlying condition is a known/accepted state (e.g. Mac Studio
    // permanently has 200+ connections from normal app traffic).
    for (const c of out) {
      const macParam = c.mac;
      const recent = this.findRecentAlert.get(macParam, macParam, c.rule) as
        | { created_at: number; dismissed_at: number | null }
        | undefined;
      if (recent) {
        const cooldown = recent.dismissed_at
          ? this.DEDUPE_AFTER_DISMISS_MS
          : this.DEDUPE_DEFAULT_MS;
        const refTs = recent.dismissed_at ?? recent.created_at;
        if (now - refTs < cooldown) continue;
      }
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
