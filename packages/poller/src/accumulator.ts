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
  online_seconds: number | null;
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
      SELECT ts, up_speed_bps, down_speed_bps, down_sum_kb, online_seconds
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
        avg_down_bps = (COALESCE(avg_down_bps, 0) * traffic_5min.sample_count + excluded.avg_down_bps) / (traffic_5min.sample_count + 1),
        avg_up_bps   = (COALESCE(avg_up_bps, 0)   * traffic_5min.sample_count + excluded.avg_up_bps)   / (traffic_5min.sample_count + 1)
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
        // Tenda firmware reports hostUploadSpeed/hostDownloadSpeed as integer KB/s.
        // Store the canonical bytes/s in the DB (legacy column name says "_bps" but means bytes/s).
        const upKBs = isOnline ? Number((dev as any).hostUploadSpeed ?? 0) : 0;
        const downKBs = isOnline ? Number((dev as any).hostDownloadSpeed ?? 0) : 0;
        const upSpeed = Math.round(upKBs * 1024);
        const downSpeed = Math.round(downKBs * 1024);
        const rawDownSumKb = Number(dev.hostDownloadSum ?? 0);
        const sessions = isOnline ? Number((dev as any).hostConnectCount ?? 0) : 0;
        const onlineSec = isOnline ? Number((dev as any).onlineTime ?? 0) : 0;

        const prev = this.lastSample.get(mac, now) as PrevSample | undefined;
        const dtSec = prev ? Math.max(1, Math.round((now - prev.ts) / 1000)) : 30;
        // If we lost contact for more than 5 min, distrust the per-device counter delta —
        // the router may have rebooted, the device may have reconnected, or our poller
        // restarted. In all those cases the gap is too long to safely credit as one delta.
        const gapTooLarge = dtSec > 5 * 60;
        const sessionRestarted = Boolean(
          prev &&
          onlineSec > 0 &&
          Number(prev.online_seconds ?? 0) > 0 &&
          onlineSec < Number(prev.online_seconds ?? 0)
        );

        let downSumKb = rawDownSumKb;
        let counterNoise = false;
        let realCounterReset = false;
        if (prev && !isReboot && !gapTooLarge && rawDownSumKb < prev.down_sum_kb) {
          // Tenda firmware can report a transient 0 or tiny post-zero value for the same
          // session. Keep the stored counter at the high-water mark so the next normal
          // sample is not credited a second time.
          if (sessionRestarted) {
            realCounterReset = true;
          } else {
            downSumKb = prev.down_sum_kb;
            counterNoise = true;
          }
        }

        let deltaDownBytes = 0;
        if (!prev) {
          // First sample for this device — treat the router's running counter as a baseline,
          // not as bytes accumulated during our watch. Future deltas will be relative to this.
          deltaDownBytes = 0;
        } else if (isReboot) {
          // Router rebooted: the new down_sum_kb starts fresh from 0; whatever it shows now is
          // bytes since reboot, so add them all.
          deltaDownBytes = downSumKb * 1024;
        } else if (gapTooLarge) {
          // Long gap without a confirmed reboot: re-baseline silently to avoid double-counting.
          log.info('accumulator: long gap, re-baselining device counter', { mac, dtSec, prevKb: prev.down_sum_kb, curKb: downSumKb });
          deltaDownBytes = 0;
        } else if (counterNoise) {
          deltaDownBytes = 0;
        } else if (realCounterReset) {
          log.info('accumulator: per-device session counter reset (treating as real)', {
            mac,
            prevKb: prev.down_sum_kb,
            curKb: downSumKb,
            prevOnlineSec: prev.online_seconds,
            curOnlineSec: onlineSec,
          });
          deltaDownBytes = downSumKb * 1024;
        } else {
          const rawDeltaKb = downSumKb - prev.down_sum_kb;
          if (rawDeltaKb > 5 * 1024 * 1024) {
            // Sanity cap: > 5 GB in one short cycle is implausible for a home network.
            log.warn('accumulator: implausible delta clamped', { mac, rawDeltaKb, dtSec });
            deltaDownBytes = 0;
          } else {
            deltaDownBytes = rawDeltaKb * 1024;
          }
        }

        // Upload bytes are estimated from instantaneous KB/s × elapsed time, because the
        // Tenda W30E firmware does not expose hostUploadSum. This undercounts bursts that
        // happen between samples; the WAN-level cumulative total (see Sampler) is the
        // ground truth for total upload.
        let deltaUpBytes = 0;
        if (prev && !gapTooLarge && isOnline) {
          const prevUp = prev.up_speed_bps;
          deltaUpBytes = Math.round(((prevUp + upSpeed) / 2) * dtSec);
        }
        // Sanity cap: avoid a corrupted speed value blowing up totals.
        if (deltaUpBytes > 5 * 1024 * 1024 * 1024) {
          log.warn('accumulator: implausible up delta clamped', { mac, deltaUpBytes, dtSec });
          deltaUpBytes = 0;
        }

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

        const bucket = bucket5Min(now);
        const activeSec = prev && !gapTooLarge && isOnline ? dtSec : 0;
        this.upsertBucket.run({
          mac,
          bucket_ts: bucket,
          bytes_down: Math.max(0, deltaDownBytes),
          bytes_up: Math.max(0, deltaUpBytes),
          speed_down: downSpeed,
          speed_up: upSpeed,
          active_sec: activeSec,
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
