import type Database from 'better-sqlite3';
import type { RouterDevice } from '@tenda/shared';
import { bucket5Min } from '@tenda/shared';
import { insertAlertIfAllowed, lookupOui, categorizeByName } from '@tenda/shared';
import { log } from './logger.js';
import { extractWifiMetrics } from './wifi-metrics.js';

interface PrevSample {
  ts: number;
  online: 0 | 1;
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
  private findOpenSession: Database.Statement;
  private insertSession: Database.Statement;
  private closeOpenSession: Database.Statement;
  private addSessionBytes: Database.Statement;
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
      INSERT OR REPLACE INTO samples_raw (
        mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, sessions, online_seconds,
        connect_type, connection_kind, wifi_band, wifi_rssi_dbm, wifi_signal_percent, wifi_distance_m, wifi_distance_source
      )
      VALUES (
        @mac, @ts, @ip, @online, @up_speed_bps, @down_speed_bps, @down_sum_kb, @sessions, @online_seconds,
        @connect_type, @connection_kind, @wifi_band, @wifi_rssi_dbm, @wifi_signal_percent, @wifi_distance_m, @wifi_distance_source
      )
    `);

    this.lastSample = db.prepare(`
      SELECT ts, online, up_speed_bps, down_speed_bps, down_sum_kb, online_seconds
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

    this.findOpenSession = db.prepare(`
      SELECT started_at, down_counter_base_kb FROM device_sessions
      WHERE mac = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `);

    this.insertSession = db.prepare(`
      INSERT INTO device_sessions (mac, started_at, ended_at, bytes_down, bytes_up, down_counter_base_kb)
      VALUES (?, ?, NULL, 0, 0, ?)
      ON CONFLICT(mac, started_at) DO UPDATE SET
        ended_at = NULL,
        down_counter_base_kb = excluded.down_counter_base_kb
    `);

    this.closeOpenSession = db.prepare(`
      UPDATE device_sessions
      SET ended_at = ?, bytes_down = bytes_down + ?, bytes_up = bytes_up + ?
      WHERE mac = ? AND ended_at IS NULL
    `);

    this.addSessionBytes = db.prepare(`
      UPDATE device_sessions
      SET bytes_down = MAX(COALESCE(bytes_down, 0) + ?, ?),
          bytes_up = COALESCE(bytes_up, 0) + ?
      WHERE mac = ? AND ended_at IS NULL
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
        // Tenda firmware reports `onlineTime` in MINUTES since the device's
        // current session started — the integer ticks once per wall-clock minute.
        // We persist it as `online_seconds` (multiplied by 60 on the way in) so
        // downstream comparisons stay in a single unit. Verified empirically: in
        // 10 minutes of wall clock, the field increments by ~10.
        const onlineMinutes = isOnline ? Number((dev as any).onlineTime ?? 0) : 0;
        const onlineSecondsForStorage = onlineMinutes * 60;
        const wifi = extractWifiMetrics(dev);

        const prev = this.lastSample.get(mac, now) as PrevSample | undefined;
        const dtSec = prev ? Math.max(1, Math.round((now - prev.ts) / 1000)) : 30;
        // If we lost contact for more than 5 min, distrust the per-device counter delta —
        // the router may have rebooted, the device may have reconnected, or our poller
        // restarted. In all those cases the gap is too long to safely credit as one delta.
        const gapTooLarge = dtSec > 5 * 60;
        const reconnected = Boolean(prev && prev.online === 0 && isOnline);
        const uptimeReset = Boolean(
          prev &&
          onlineSecondsForStorage > 0 &&
          Number(prev.online_seconds ?? 0) > 0 &&
          onlineSecondsForStorage < Number(prev.online_seconds ?? 0)
        );
        const sessionRestarted = reconnected || uptimeReset;

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
            curOnlineSec: onlineSecondsForStorage,
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
        const seedSessionFromCounter = !sessionRestarted || isReboot || realCounterReset;
        const sessionCounterBaseKb = seedSessionFromCounter
          ? 0
          : Math.max(0, Number(prev?.down_sum_kb ?? downSumKb));

        // Upload bytes are estimated from instantaneous KB/s × elapsed time, because the
        // Tenda W30E firmware does not expose hostUploadSum. We use min(prevUp, upSpeed)
        // as a conservative lower-bound estimator: trapezoidal/mean integration was
        // overshooting because a single high sample (a burst peak captured at sample
        // time) gets extrapolated over the full sample interval. Min-of-pair gives a
        // safe estimate that matches WAN ground truth much more closely.
        let deltaUpBytes = 0;
        if (prev && !gapTooLarge && isOnline) {
          const prevUp = prev.up_speed_bps;
          deltaUpBytes = Math.round(Math.min(prevUp, upSpeed) * dtSec);
        }
        // Sanity cap: bytes/sec must not exceed the higher endpoint by more than 10%.
        const upBoundBytesPerSec = Math.max(prev?.up_speed_bps ?? 0, upSpeed);
        const maxBytesThisCycle = Math.round(upBoundBytesPerSec * dtSec * 1.1);
        if (deltaUpBytes > maxBytesThisCycle) {
          deltaUpBytes = maxBytesThisCycle;
        }
        if (deltaUpBytes > 5 * 1024 * 1024 * 1024) {
          log.warn('accumulator: implausible up delta clamped', { mac, deltaUpBytes, dtSec });
          deltaUpBytes = 0;
        }

        this.updateSession(
          mac,
          now,
          isOnline,
          onlineMinutes,
          sessionRestarted,
          deltaDownBytes,
          deltaUpBytes,
          downSumKb,
          sessionCounterBaseKb,
        );

        this.insertSample.run({
          mac,
          ts: now,
          ip: dev.hostIP || null,
          online: isOnline ? 1 : 0,
          up_speed_bps: upSpeed,
          down_speed_bps: downSpeed,
          down_sum_kb: downSumKb,
          sessions,
          online_seconds: onlineSecondsForStorage,
          connect_type: wifi.connectType,
          connection_kind: wifi.connectionKind,
          wifi_band: wifi.wifiBand,
          wifi_rssi_dbm: wifi.wifiRssiDbm,
          wifi_signal_percent: wifi.wifiSignalPercent,
          wifi_distance_m: wifi.wifiDistanceM,
          wifi_distance_source: wifi.wifiDistanceSource,
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
          insertAlertIfAllowed(this.db, 'new_device', mac, {
            mac,
            hostname: dev.hostName,
            ip: dev.hostIP,
            vendor: oui.vendor,
            category: guessedCategory,
            router_id: dev.ID,
            router_remark: dev.hostRemark || null,
            connect_type: wifi.connectType,
            connection_kind: wifi.connectionKind,
            wifi_band: wifi.wifiBand,
          }, now);
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

  private updateSession(
    mac: string,
    now: number,
    isOnline: boolean,
    onlineMinutes: number,
    sessionRestarted: boolean,
    bytesDown: number,
    bytesUp: number,
    downSumKb: number,
    sessionCounterBaseKb: number,
  ): void {
    let open = this.findOpenSession.get(mac) as { started_at: number; down_counter_base_kb: number | null } | undefined;
    if (!isOnline) {
      if (open) this.closeOpenSession.run(now, 0, 0, mac);
      return;
    }

    if (open && sessionRestarted) {
      this.closeOpenSession.run(now, 0, 0, mac);
      open = undefined;
    }

    if (!open) {
      const baseKb = Math.max(0, sessionCounterBaseKb);
      const startedAt = inferSessionStart(now, onlineMinutes);
      this.insertSession.run(mac, startedAt, baseKb);
      open = { started_at: startedAt, down_counter_base_kb: baseKb };
    }
    const counterBaseKb = Math.max(0, Number(open.down_counter_base_kb ?? 0));
    const counterSessionBytes = Math.max(0, (downSumKb - counterBaseKb) * 1024);
    this.addSessionBytes.run(
      Math.max(0, bytesDown),
      Math.max(0, counterSessionBytes),
      Math.max(0, bytesUp),
      mac,
    );
  }
}

function inferSessionStart(now: number, onlineMinutes: number): number {
  const minutes = Number.isFinite(onlineMinutes) && onlineMinutes > 0 ? onlineMinutes : 0;
  return now - Math.round(minutes * 60_000);
}
