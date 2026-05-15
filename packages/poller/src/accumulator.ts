import type Database from 'better-sqlite3';
import type { RouterDevice } from '@tenda/shared';
import { bucket5Min } from '@tenda/shared';
import { lookupOui, categorizeByName } from '@tenda/shared';
import { log } from './logger.js';

interface PrevSample {
  ts: number;
  up_speed_bps: number;
  down_speed_bps: number;
  down_sum_kb: number;
}

interface AccumulateResult {
  newDevices: string[];      // MACs that we saw for the first time
  totalBytesDownDelta: number;
  totalBytesUpDelta: number;
  deviceCount: number;
}

export class Accumulator {
  private upsertDevice: Database.Statement;
  private insertSample: Database.Statement;
  private lastSample: Database.Statement;
  private upsertBucket: Database.Statement;
  private fetchDevice: Database.Statement;
  private insertAlert: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.upsertDevice = db.prepare(`
      INSERT INTO devices (mac, router_id, hostname, router_remark, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
      VALUES (@mac, @router_id, @hostname, @router_remark, @vendor, @category, @first_seen, @last_seen, 1, @now, @now)
      ON CONFLICT(mac) DO UPDATE SET
        router_id = excluded.router_id,
        hostname  = COALESCE(excluded.hostname, devices.hostname),
        router_remark = COALESCE(excluded.router_remark, devices.router_remark),
        vendor    = COALESCE(devices.vendor, excluded.vendor),
        category  = COALESCE(devices.category, excluded.category),
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `);

    this.fetchDevice = db.prepare(`SELECT mac FROM devices WHERE mac = ?`);

    this.insertSample = db.prepare(`
      INSERT OR REPLACE INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, sessions, online_seconds)
      VALUES (@mac, @ts, @ip, @online, @up_speed_bps, @down_speed_bps, @down_sum_kb, @sessions, @online_seconds)
    `);

    this.lastSample = db.prepare(`
      SELECT ts, up_speed_bps, down_speed_bps, down_sum_kb
      FROM samples_raw
      WHERE mac = ? AND ts < ?
      ORDER BY ts DESC
      LIMIT 1
    `);

    this.upsertBucket = db.prepare(`
      INSERT INTO traffic_5min (mac, bucket_ts, bytes_down, bytes_up, avg_down_bps, avg_up_bps, peak_down_bps, peak_up_bps, active_sec, sample_count)
      VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @speed_down, @speed_up, @speed_down, @speed_up, @active_sec, 1)
      ON CONFLICT(mac, bucket_ts) DO UPDATE SET
        bytes_down = bytes_down + excluded.bytes_down,
        bytes_up   = bytes_up   + excluded.bytes_up,
        peak_down_bps = MAX(COALESCE(peak_down_bps, 0), excluded.peak_down_bps),
        peak_up_bps   = MAX(COALESCE(peak_up_bps, 0), excluded.peak_up_bps),
        active_sec = active_sec + excluded.active_sec,
        sample_count = sample_count + 1,
        avg_down_bps = (COALESCE(avg_down_bps, 0) * (sample_count - 1) + excluded.avg_down_bps) / sample_count,
        avg_up_bps   = (COALESCE(avg_up_bps, 0)   * (sample_count - 1) + excluded.avg_up_bps)   / sample_count
    `);

    this.insertAlert = db.prepare(`
      INSERT INTO alerts (kind, mac, payload, created_at) VALUES (?, ?, ?, ?)
    `);
  }

  /** True if our DB has never seen this MAC. */
  private isUnknownDevice(mac: string): boolean {
    return !this.fetchDevice.get(mac);
  }

  /** Process one polling cycle. */
  process(now: number, devices: RouterDevice[], isReboot: boolean): AccumulateResult {
    const newDevices: string[] = [];
    let totalDown = 0;
    let totalUp = 0;

    const txn = this.db.transaction(() => {
      for (const dev of devices) {
        const mac = (dev.hostMAC || '').toUpperCase();
        if (!mac) continue;

        const isNew = this.isUnknownDevice(mac);
        if (isNew) newDevices.push(mac);

        const oui = lookupOui(mac);
        const guessedCategory = categorizeByName(dev.hostName) ?? oui.category ?? null;

        this.upsertDevice.run({
          mac,
          router_id: dev.ID,
          hostname: dev.hostName || null,
          router_remark: dev.hostRemark || null,
          vendor: oui.vendor,
          category: guessedCategory,
          first_seen: now,
          last_seen: now,
          now,
        });

        const isOnline = dev.hostOnlineStatus === 1;
        const upSpeed = isOnline ? Number((dev as any).hostUploadSpeed ?? 0) : 0;
        const downSpeed = isOnline ? Number((dev as any).hostDownloadSpeed ?? 0) : 0;
        const downSumKb = Number(dev.hostDownloadSum ?? 0);
        const sessions = isOnline ? Number((dev as any).hostConnectCount ?? 0) : 0;
        const onlineSec = isOnline ? Number((dev as any).onlineTime ?? 0) : 0;

        this.insertSample.run({
          mac,
          ts: now,
          ip: dev.hostIP || null,
          online: isOnline ? 1 : 0,
          up_speed_bps: upSpeed,
          down_speed_bps: downSpeed,
          down_sum_kb: downSumKb,
          sessions,
          online_seconds: onlineSec,
        });

        const prev = this.lastSample.get(mac, now) as PrevSample | undefined;
        const dtSec = prev ? Math.max(1, Math.round((now - prev.ts) / 1000)) : 30;

        let deltaDownBytes = 0;
        if (!prev) {
          // First sample for this device — treat the router's running counter as a baseline,
          // not as bytes accumulated during our watch. Future deltas will be relative to this.
          deltaDownBytes = 0;
        } else if (isReboot) {
          // Router rebooted: the new down_sum_kb starts fresh from 0; whatever it shows now is
          // bytes since reboot, so add them all.
          deltaDownBytes = downSumKb * 1024;
        } else {
          const rawDeltaKb = downSumKb - prev.down_sum_kb;
          if (rawDeltaKb < 0) {
            // Counter went backwards without an uptime regression — likely a partial reset or
            // device-side counter wrap. Trust the new value as bytes since the reset.
            deltaDownBytes = downSumKb * 1024;
          } else if (rawDeltaKb > 50 * 1024 * 1024) {
            // Sanity cap: > 50GB in one cycle is implausible
            log.warn('accumulator: implausible delta clamped', { mac, rawDeltaKb });
            deltaDownBytes = 0;
          } else {
            deltaDownBytes = rawDeltaKb * 1024;
          }
        }

        const prevUp = prev?.up_speed_bps ?? upSpeed;
        const deltaUpBytes = Math.round(((prevUp + upSpeed) / 2) * dtSec);

        const bucket = bucket5Min(now);
        this.upsertBucket.run({
          mac,
          bucket_ts: bucket,
          bytes_down: Math.max(0, deltaDownBytes),
          bytes_up: Math.max(0, deltaUpBytes),
          speed_down: downSpeed,
          speed_up: upSpeed,
          active_sec: isOnline ? dtSec : 0,
        });

        totalDown += deltaDownBytes;
        totalUp += deltaUpBytes;

        if (isNew) {
          this.insertAlert.run('new_device', mac, JSON.stringify({
            hostname: dev.hostName,
            ip: dev.hostIP,
            vendor: oui.vendor,
          }), now);
        }
      }
    });

    txn();

    return {
      newDevices,
      totalBytesDownDelta: totalDown,
      totalBytesUpDelta: totalUp,
      deviceCount: devices.length,
    };
  }
}
