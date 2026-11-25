import type Database from 'better-sqlite3';
import type { RouterDevice } from '@tenda/shared';
import {
  PiiSessionSanitizer,
  correlateDeviceWindowLanOrWan,
  insertAlertIfAllowed,
  isAiReady,
  isAic8800FallbackMac,
  lookupOui,
  resolveGeminiApiKey,
  triageSecurityFinding,
} from '@tenda/shared';
import { log } from './logger.js';

export interface SecurityCheck {
  rule: string;
  severity: 'info' | 'warn' | 'critical';
  mac: string | null;
  message: string;
  detail?: any;
}

/** Shape of one device entry we include in alert payloads. */
interface AffectedDevice {
  mac: string;
  ip: string | null;
  hostname: string | null;
  router_remark: string | null;
  vendor: string | null;
  category: string | null;
  connect_type: number | null;
  reserved: boolean;
}

function describeDevice(d: any, reservedMacs?: Set<string>): AffectedDevice {
  const mac = String(d.hostMAC || '').toUpperCase();
  const oui = mac ? lookupOui(mac) : { vendor: null as any, category: null as any };
  return {
    mac,
    ip: d.hostIP ?? null,
    hostname: d.hostName ?? null,
    router_remark: d.hostRemark ?? null,
    vendor: oui.vendor ?? null,
    category: oui.category ?? null,
    connect_type: d.hostConnectType ?? null,
    reserved: reservedMacs ? reservedMacs.has(mac) : false,
  };
}

function deviceLabel(d: any): string {
  return d.hostRemark || d.hostName || d.hostMAC || '';
}

/**
 * Heuristic security checks that run each cycle. We can't do real IDS without packet
 * inspection — these are pattern-based flags computed from the data we already have.
 *
 * Every finding now carries the affected device's full context (MAC, IP, hostname,
 * vendor, category) inside `detail`, so the UI can show the user *who* triggered the
 * rule instead of an opaque "N devices …" banner.
 */
export class SecurityScanner {
  private insertAlert: Database.Statement;
  private findRecentAlert: Database.Statement;
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

  scan(now: number, devices: RouterDevice[], reservedMacs: Set<string> = new Set()): SecurityCheck[] {
    const out: SecurityCheck[] = [];
    const filteredDevices = devices.filter((d) => !isAic8800FallbackMac(d.hostMAC));
    const onlineDevices = filteredDevices.filter((d) => d.hostOnlineStatus === 1) as any[];

    // 1. Connection-count spike (possible port scan / many sockets)
    for (const d of onlineDevices) {
      const conn = d.hostConnectCount ?? 0;
      if (conn >= 200) {
        out.push({
          rule: 'high_connection_count',
          severity: conn >= 500 ? 'critical' : 'warn',
          mac: d.hostMAC,
          message: `${deviceLabel(d)} has ${conn} concurrent connections`,
          detail: {
            connections: conn,
            ...describeDevice(d, reservedMacs),
          },
        });
      }
    }

    // 2. Sudden high upload speed (potential exfiltration / outbound DDoS) + role-aware IoT/Camera WAN upload check
    for (const d of onlineDevices) {
      // Tenda reports per-client speed as integer KB/s in the UI/API.
      const up = Math.round(Number(d.hostUploadSpeed ?? 0) * 1024);
      const desc = describeDevice(d, reservedMacs);
      const isRestrictedRole = desc.category === 'camera' || desc.category === 'iot' || desc.category === 'printer';

      if (isRestrictedRole && up > 1.5 * 1024 * 1024) {
        // Distinguish benign LAN camera -> Frigate NVR stream from actual external WAN upload!
        const corr = correlateDeviceWindowLanOrWan(this.db, up * 30, now - 60_000, now);
        if (corr.attribution !== 'lan_only') {
          out.push({
            rule: 'camera_external_upload',
            severity: 'warn',
            mac: d.hostMAC,
            message: `${deviceLabel(d)} (${desc.category}) uploading externally at ${(up / 1024 / 1024).toFixed(1)} MB/s (${corr.attribution.toUpperCase()})`,
            detail: {
              up_bps: up,
              up_human: `${(up / 1024 / 1024).toFixed(1)} MB/s`,
              lan_or_wan: corr.attribution,
              ...desc,
            },
          });
          continue;
        }
      }

      if (up > 5 * 1024 * 1024) { // 5 MB/s sustained upload
        const corr = correlateDeviceWindowLanOrWan(this.db, up * 30, now - 60_000, now);
        if (isRestrictedRole && corr.attribution === 'lan_only') continue;
        out.push({
          rule: 'high_upload',
          severity: up > 20 * 1024 * 1024 ? 'critical' : 'warn',
          mac: d.hostMAC,
          message: `${deviceLabel(d)} uploading at ${(up / 1024 / 1024).toFixed(1)} MB/s`,
          detail: {
            up_bps: up,
            up_human: `${(up / 1024 / 1024).toFixed(1)} MB/s`,
            lan_or_wan: corr.attribution,
            ...desc,
          },
        });
      }
    }

    // 2b. Multi-MAC IP Churn (3+ distinct hardware MACs claiming the same LAN IP within 30 minutes)
    try {
      const churnRows = this.db
        .prepare(`
          SELECT ip, COUNT(DISTINCT mac) AS mac_cnt, GROUP_CONCAT(DISTINCT mac) AS macs_csv
          FROM samples_raw
          WHERE ts >= ? AND ip IS NOT NULL AND ip != '' AND mac NOT LIKE '88:00:33:77:%'
          GROUP BY ip
          HAVING mac_cnt >= 3
        `)
        .all(now - 30 * 60_000) as Array<{ ip: string; mac_cnt: number; macs_csv: string }>;
      for (const ch of churnRows) {
        out.push({
          rule: 'ip_mac_churn',
          severity: 'warn',
          mac: null,
          message: `LAN IP ${ch.ip} claimed by ${ch.mac_cnt} distinct MACs in 30 minutes`,
          detail: {
            ip: ch.ip,
            count: ch.mac_cnt,
            macs: ch.macs_csv ? ch.macs_csv.split(',') : [],
          },
        });
      }
    } catch {
      // Optional in minimal test DBs
    }

    // 3. Locally-administered MAC = device with randomized/spoofed address.
    //    iOS/Android private MAC. We emit one info-level finding *per device*,
    //    so the security page lists exactly which MACs are randomized, and
    //    dedupe keeps each MAC from re-firing once acknowledged.
    //
    //    Devices the user has reserved on the router (Address Reservation)
    //    are intentionally accepted — silence the finding for them.
    for (const d of filteredDevices as any[]) {
      const mac = String(d.hostMAC || '').toUpperCase();
      if (!mac) continue;
      const first = parseInt(mac.slice(0, 2), 16);
      if (Number.isNaN(first) || !(first & 0x02)) continue;
      if (reservedMacs.has(mac)) continue;
      out.push({
        rule: 'random_mac_device',
        severity: 'info',
        mac,
        message: `${deviceLabel(d)} uses a randomized MAC address`,
        detail: describeDevice(d, reservedMacs),
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
          detail: {
            hostname: name,
            count: arr.length,
            // Keep legacy `macs` for any external consumer; add structured list too.
            macs: arr.map((x) => x.hostMAC),
            devices: arr.map((m) => describeDevice(m, reservedMacs)),
          },
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
      const expectedSubnet = dominant[0] + '.0/24';
      for (const d of onlineDevices) {
        const ip = d.hostIP || '';
        if (ip && !ip.startsWith(lanPrefix)) {
          out.push({
            rule: 'out_of_subnet',
            severity: 'warn',
            mac: d.hostMAC,
            message: `${deviceLabel(d)} reports IP ${ip} outside the LAN subnet (${dominant[0]}.x)`,
            detail: {
              ...describeDevice(d, reservedMacs),
              // Override the device IP with the reported (out-of-subnet) one for clarity.
              ip,
              expected_subnet: expectedSubnet,
              // Legacy field for any older UI: keep `lan` for backwards-compat.
              lan: expectedSubnet,
            },
          });
        }
      }
    }

    // Persist with smart dedupe: respect user-dismissed alerts for 24h to prevent
    // spam when the underlying condition is a known/accepted state (e.g. Mac Studio
    // permanently has 200+ connections from normal app traffic).
    const inserted: SecurityCheck[] = [];
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
        const result = insertAlertIfAllowed(this.db, 'security', c.mac, {
          rule: c.rule,
          severity: c.severity,
          message: c.message,
          detail: c.detail,
        }, now);
        if (result.inserted) inserted.push(c);
      } catch (e) {
        log.warn('failed to persist security alert', String(e));
      }
    }

    return inserted;
  }

  /**
   * Calibrated false-positive & severity triage via `gemini-decision-1` (`v1beta`).
   * Stores verdict into `ai_insights` so `/security` shows instant calibrated badges.
   */
  async triageFindingsWithAi(checks: SecurityCheck[], now = Date.now()): Promise<void> {
    if (checks.length === 0 || !isAiReady(this.db, 'security')) return;
    const { apiKey } = resolveGeminiApiKey(this.db);
    if (!apiKey) return;

    const hasInsights = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ai_insights'`)
      .get() as { ok: number } | undefined;
    if (!hasInsights?.ok) return;

    const sanitizer = new PiiSessionSanitizer(this.db);
    for (const c of checks.slice(0, 5)) {
      try {
        const sanitized = sanitizer.sanitizeValue({
          rule: c.rule,
          severity: c.severity,
          detail: c.detail ?? {},
        });
        const verdict = await triageSecurityFinding(apiKey, JSON.stringify(sanitized));
        const scopeKey = `${c.rule}:${c.mac ?? 'network'}`;
        this.db
          .prepare(`
            INSERT INTO ai_insights (
              scope_type, scope_key, verdict, lan_or_wan, title_ar, explanation_ar, recommended_action_json, model_used, created_at
            ) VALUES ('security_triage', ?, ?, ?, ?, ?, NULL, 'gemini-decision-1', ?)
            ON CONFLICT(scope_type, scope_key) DO UPDATE SET
              verdict = excluded.verdict,
              created_at = excluded.created_at
          `)
          .run(
            scopeKey,
            verdict.verdict,
            c.detail?.lan_or_wan ?? null,
            verdict.verdict === 'benign' ? 'سلوك معتاد للجهاز' : 'يستحق المراجعة الأمنية',
            `ثقة التصنيف المعاير: ${Math.round(verdict.confidence * 100)}%`,
            now,
          );
      } catch (e) {
        log.debug('security ai triage skipped', String(e));
      }
    }
  }
}
