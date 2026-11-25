import type Database from 'better-sqlite3';
import type { RouterDevice } from '@tenda/shared';
import { bucket5Min } from '@tenda/shared';
import {
  insertAlertIfAllowed,
  lookupOui,
  categorizeByName,
  isAic8800FallbackMac,
  isLocalInfraCategory,
} from '@tenda/shared';
import { log } from './logger.js';
import { enqueueNewDeviceForAutoQos, isValidLanIpv4 } from './traffic-control.js';
import { extractWifiMetrics } from './wifi-metrics.js';

const TENDA_INT32_MAX_KB_SENTINEL = 2_097_151; // 0x7fffffff >> 10
const TENDA_UINT32_MAX_KB_SENTINEL = 4_194_303; // 0xffffffff >> 10

export function isTendaCounterSentinelKb(kb: number): boolean {
  return kb === TENDA_INT32_MAX_KB_SENTINEL || kb === TENDA_UINT32_MAX_KB_SENTINEL || kb < 0;
}

function sanitizeRouterHostIp(rawIp: string | null | undefined, fallbackIp?: string | null): string | null {
  const clean = (rawIp ?? '').trim();
  if (clean && isValidLanIpv4(clean)) return clean;
  const fb = (fallbackIp ?? '').trim();
  return fb && isValidLanIpv4(fb) ? fb : null;
}

interface PrevSample {
  ts: number;
  ip?: string | null;
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
  private touchDeviceLastSeen: Database.Statement;
  private findCanonicalBySampleIp: Database.Statement;
  private findCanonicalByReservedIp: Database.Statement | null = null;
  private insertAlert: Database.Statement;
  private ephemeralPrev = new Map<string, PrevSample>();
  private prevWanSnapshot: { ts: number; upBps: number; downBps: number } | null = null;

  constructor(private readonly db: Database.Database) {
    this.upsertDevice = db.prepare(`
      INSERT INTO devices (mac, router_id, hostname, router_remark, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
      VALUES (@mac, @router_id, @hostname, @router_remark, @vendor, @category, @first_seen, @last_seen, 1, @now, @now)
      ON CONFLICT(mac) DO UPDATE SET
        router_id = excluded.router_id,
        hostname  = COALESCE(NULLIF(excluded.hostname, ''), devices.hostname),
        router_remark = COALESCE(NULLIF(excluded.router_remark, ''), devices.router_remark),
        vendor    = CASE
          WHEN devices.vendor IS NULL OR TRIM(devices.vendor) = '' OR LOWER(TRIM(devices.vendor)) = 'unknown'
          THEN COALESCE(NULLIF(excluded.vendor, ''), devices.vendor)
          ELSE devices.vendor
        END,
        category  = CASE
          WHEN devices.category IS NULL OR TRIM(devices.category) = '' OR LOWER(TRIM(devices.category)) = 'unknown'
          THEN COALESCE(NULLIF(excluded.category, ''), devices.category)
          ELSE devices.category
        END,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `);

    this.fetchDevice = db.prepare(`SELECT mac, category FROM devices WHERE mac = ?`);
    this.touchDeviceLastSeen = db.prepare(`UPDATE devices SET last_seen = MAX(last_seen, ?), updated_at = ? WHERE mac = ?`);
    this.findCanonicalBySampleIp = db.prepare(`
      SELECT d.mac
      FROM devices d
      WHERE d.mac NOT LIKE '88:00:33:77:%'
        AND (
          SELECT s.ip FROM samples_raw s
          WHERE s.mac = d.mac AND s.ip IS NOT NULL AND s.ip != ''
          ORDER BY s.ts DESC LIMIT 1
        ) = ?
      ORDER BY d.last_seen DESC
      LIMIT 1
    `);
    try {
      const hasReservations = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dhcp_reservations'`).get();
      if (hasReservations) {
        this.findCanonicalByReservedIp = db.prepare(`
          SELECT mac FROM dhcp_reservations
          WHERE ip = ? AND mac NOT LIKE '88:00:33:77:%'
          LIMIT 1
        `);
      }
    } catch {
      this.findCanonicalByReservedIp = null;
    }

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
      SELECT ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, online_seconds
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

  /**
   * Resolve the real hardware MAC owning `ip` when an AIC8800 Wi-Fi camera
   * momentarily associates with its `88:00:33:77:XX:XX` boot-fallback MAC.
   */
  private resolveCanonicalMacForIp(ip: string | null | undefined, batchDevices: RouterDevice[]): string | null {
    const cleanIp = (ip || '').trim();
    if (!cleanIp) return null;

    if (this.findCanonicalByReservedIp) {
      const res = this.findCanonicalByReservedIp.get(cleanIp) as { mac: string } | undefined;
      if (res?.mac) return res.mac.toUpperCase();
    }

    const fromBatch = batchDevices.find((d) => {
      const m = (d.hostMAC || '').toUpperCase();
      return m.length > 0 && !isAic8800FallbackMac(m) && (d.hostIP || '').trim() === cleanIp;
    });
    if (fromBatch?.hostMAC) {
      const candidate = fromBatch.hostMAC.toUpperCase();
      if (this.fetchDevice.get(candidate)) return candidate;
    }

    const fromDb = this.findCanonicalBySampleIp.get(cleanIp) as { mac: string } | undefined;
    return fromDb?.mac ? fromDb.mac.toUpperCase() : null;
  }

  private processEphemeralFallback(
    now: number,
    mac: string,
    dev: RouterDevice,
    batchDevices: RouterDevice[],
    isReboot: boolean,
  ): { deltaDownBytes: number; deltaUpBytes: number } {
    const isOnline = dev.hostOnlineStatus === 1;
    const prev = this.ephemeralPrev.get(mac);
    if (!isOnline) {
      if (prev) {
        this.ephemeralPrev.set(mac, { ...prev, ts: now, online: 0, up_speed_bps: 0, down_speed_bps: 0 });
      }
      return { deltaDownBytes: 0, deltaUpBytes: 0 };
    }

    const upKBs = Number((dev as any).hostUploadSpeed ?? 0);
    const downKBs = Number((dev as any).hostDownloadSpeed ?? 0);
    const upSpeed = Math.round(upKBs * 1024);
    const downSpeed = Math.round(downKBs * 1024);
    const rawDownSumKb = Number(dev.hostDownloadSum ?? 0);
    const onlineMinutes = Number((dev as any).onlineTime ?? 0);
    const onlineSecondsForStorage = onlineMinutes * 60;

    const dtSec = prev ? Math.max(1, Math.round((now - prev.ts) / 1000)) : 30;
    const gapTooLarge = dtSec > 5 * 60;
    const reconnected = Boolean(prev && prev.online === 0);
    const uptimeReset = Boolean(
      prev &&
      onlineSecondsForStorage > 0 &&
      Number(prev.online_seconds ?? 0) > 0 &&
      onlineSecondsForStorage < Number(prev.online_seconds ?? 0)
    );
    const sessionRestarted = reconnected || uptimeReset;

    let downSumKb = rawDownSumKb;
    let deltaDownBytes = 0;
    if (!prev) {
      deltaDownBytes = 0;
    } else if (isReboot) {
      deltaDownBytes = downSumKb * 1024;
    } else if (gapTooLarge) {
      deltaDownBytes = 0;
    } else if (rawDownSumKb < prev.down_sum_kb) {
      if (sessionRestarted) {
        deltaDownBytes = downSumKb * 1024;
      } else {
        downSumKb = prev.down_sum_kb;
        deltaDownBytes = 0;
      }
    } else {
      const rawDeltaKb = downSumKb - prev.down_sum_kb;
      deltaDownBytes = rawDeltaKb > 5 * 1024 * 1024 ? 0 : rawDeltaKb * 1024;
    }

    let deltaUpBytes = 0;
    if (prev && !gapTooLarge) {
      deltaUpBytes = Math.round(Math.min(prev.up_speed_bps, upSpeed) * dtSec);
    }

    this.ephemeralPrev.set(mac, {
      ts: now,
      online: 1,
      up_speed_bps: upSpeed,
      down_speed_bps: downSpeed,
      down_sum_kb: downSumKb,
      online_seconds: onlineSecondsForStorage,
    });

    const canonicalMac = this.resolveCanonicalMacForIp(dev.hostIP, batchDevices);
    if (canonicalMac) {
      this.touchDeviceLastSeen.run(now, now, canonicalMac);
      this.upsertBucket.run({
        mac: canonicalMac,
        bucket_ts: bucket5Min(now),
        bytes_down: Math.max(0, deltaDownBytes),
        bytes_up: Math.max(0, deltaUpBytes),
        speed_down: downSpeed,
        speed_up: upSpeed,
        active_sec: prev && !gapTooLarge ? dtSec : 0,
      });
      return { deltaDownBytes: Math.max(0, deltaDownBytes), deltaUpBytes: Math.max(0, deltaUpBytes) };
    }

    log.debug('accumulator: suppressed unmapped AIC8800 boot-fallback MAC', { mac, ip: dev.hostIP });
    return { deltaDownBytes: 0, deltaUpBytes: 0 };
  }

  /** Process one polling cycle. */
  process(
    now: number,
    devices: RouterDevice[],
    isReboot: boolean,
    wanFlux?: Array<{ id: number; upBps: number; downBps: number }>,
  ): AccumulateResult {
    const newDevices: string[] = [];
    let totalDown = 0;
    let totalUp = 0;

    // Pre-compute WAN tick upload ceiling when router WAN flux is provided simultaneously
    let wanTickUpCeilingBytes: number | null = null;
    if (Array.isArray(wanFlux) && wanFlux.length > 0) {
      const curWanUpBps = wanFlux.reduce((s, w) => s + Math.max(0, Number(w.upBps ?? 0)), 0);
      const curWanDownBps = wanFlux.reduce((s, w) => s + Math.max(0, Number(w.downBps ?? 0)), 0);
      if (this.prevWanSnapshot && now > this.prevWanSnapshot.ts && now - this.prevWanSnapshot.ts <= 5 * 60_000) {
        const wanDtSec = Math.max(1, Math.round((now - this.prevWanSnapshot.ts) / 1000));
        wanTickUpCeilingBytes = Math.round(((this.prevWanSnapshot.upBps + curWanUpBps) / 2) * wanDtSec);
      }
      this.prevWanSnapshot = { ts: now, upBps: curWanUpBps, downBps: curWanDownBps };
    }

    interface PreparedDeviceRow {
      dev: RouterDevice;
      mac: string;
      isNew: boolean;
      oui: ReturnType<typeof lookupOui>;
      guessedCategory: string | null;
      isOnline: boolean;
      cleanIp: string | null;
      upSpeed: number;
      downSpeed: number;
      downSumKb: number;
      sessions: number;
      onlineMinutes: number;
      onlineSecondsForStorage: number;
      wifi: ReturnType<typeof extractWifiMetrics>;
      prev: PrevSample | undefined;
      dtSec: number;
      gapTooLarge: boolean;
      sessionRestarted: boolean;
      deltaDownBytes: number;
      sessionCounterBaseKb: number;
      candidateUpBytes: number;
      isLocalCameraOrBridge: boolean;
    }

    const txn = this.db.transaction(() => {
      const prepared: PreparedDeviceRow[] = [];

      for (const dev of devices) {
        const mac = (dev.hostMAC || '').toUpperCase();
        if (!mac) continue;

        if (isAic8800FallbackMac(mac)) {
          const eph = this.processEphemeralFallback(now, mac, dev, devices, isReboot);
          totalDown += eph.deltaDownBytes;
          totalUp += wanTickUpCeilingBytes !== null ? 0 : eph.deltaUpBytes;
          continue;
        }

        const existingDev = this.fetchDevice.get(mac) as { mac: string; category: string | null } | undefined;
        const isNew = !existingDev;
        if (isNew) newDevices.push(mac);

        const oui = lookupOui(mac);
        const guessedCategory = categorizeByName(dev.hostName) ?? categorizeByName(dev.hostRemark) ?? oui.category ?? null;
        const effectiveCategory =
          existingDev?.category && existingDev.category !== 'unknown'
            ? existingDev.category
            : guessedCategory;

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
        const prev = this.lastSample.get(mac, now) as PrevSample | undefined;
        const cleanIp = sanitizeRouterHostIp(dev.hostIP, prev?.ip);

        // Tenda firmware reports hostUploadSpeed/hostDownloadSpeed as integer KB/s.
        const upKBs = isOnline ? Number((dev as any).hostUploadSpeed ?? 0) : 0;
        const downKBs = isOnline ? Number((dev as any).hostDownloadSpeed ?? 0) : 0;
        const upSpeed = Math.round(upKBs * 1024);
        const downSpeed = Math.round(downKBs * 1024);

        let rawDownSumKb = Number(dev.hostDownloadSum ?? 0);
        // Filter Tenda 32-bit INT32/UINT32 overflow/offline sentinels (2097151 / 4194303)
        // and ignore counter mutations while the host is marked offline.
        if (isTendaCounterSentinelKb(rawDownSumKb) || (!isOnline && prev)) {
          rawDownSumKb = prev ? prev.down_sum_kb : 0;
        }

        const sessions = isOnline ? Number((dev as any).hostConnectCount ?? 0) : 0;
        const onlineMinutes = isOnline ? Number((dev as any).onlineTime ?? 0) : 0;
        const onlineSecondsForStorage = onlineMinutes * 60;
        const wifi = extractWifiMetrics(dev);

        const dtSec = prev ? Math.max(1, Math.round((now - prev.ts) / 1000)) : 30;
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
          if (sessionRestarted) {
            realCounterReset = true;
          } else {
            downSumKb = prev.down_sum_kb;
            counterNoise = true;
          }
        }

        const maxLineKbs = Math.max(25_600, Math.round(((prev?.down_speed_bps ?? 0) + downSpeed) / 2048) * 4);
        const maxPlausibleTickKb = Math.max(64 * 1024, maxLineKbs * dtSec);

        let deltaDownBytes = 0;
        let rebaselinedStaleReset = false;
        if (!prev) {
          deltaDownBytes = 0;
        } else if (isReboot) {
          if (downSumKb <= maxPlausibleTickKb) {
            deltaDownBytes = downSumKb * 1024;
          } else {
            deltaDownBytes = Math.round((((prev.down_speed_bps ?? 0) + downSpeed) / 2) * dtSec);
            rebaselinedStaleReset = true;
          }
        } else if (gapTooLarge) {
          log.info('accumulator: long gap, re-baselining device counter', { mac, dtSec, prevKb: prev.down_sum_kb, curKb: downSumKb });
          deltaDownBytes = 0;
        } else if (counterNoise) {
          deltaDownBytes = 0;
        } else if (realCounterReset) {
          if (downSumKb <= maxPlausibleTickKb) {
            log.info('accumulator: per-device session counter reset (treating as real)', {
              mac,
              prevKb: prev.down_sum_kb,
              curKb: downSumKb,
              prevOnlineSec: prev.online_seconds,
              curOnlineSec: onlineSecondsForStorage,
            });
            deltaDownBytes = downSumKb * 1024;
          } else {
            log.warn('accumulator: implausible post-reset counter carry-over; re-baselining', {
              mac,
              prevKb: prev.down_sum_kb,
              curKb: downSumKb,
              dtSec,
            });
            deltaDownBytes = Math.round((((prev.down_speed_bps ?? 0) + downSpeed) / 2) * dtSec);
            rebaselinedStaleReset = true;
          }
        } else {
          const rawDeltaKb = downSumKb - prev.down_sum_kb;
          if (rawDeltaKb > 5 * 1024 * 1024 || (dtSec <= 90 && rawDeltaKb > Math.max(512 * 1024, maxPlausibleTickKb * 2))) {
            log.warn('accumulator: implausible delta clamped', { mac, rawDeltaKb, dtSec });
            deltaDownBytes = Math.round((((prev.down_speed_bps ?? 0) + downSpeed) / 2) * dtSec);
          } else {
            deltaDownBytes = rawDeltaKb * 1024;
          }
        }

        const seedSessionFromCounter = (!sessionRestarted || isReboot || realCounterReset) && !rebaselinedStaleReset;
        const sessionCounterBaseKb = seedSessionFromCounter
          ? 0
          : Math.max(0, rebaselinedStaleReset ? downSumKb : Number(prev?.down_sum_kb ?? downSumKb));

        const isLocalCameraOrBridge =
          isLocalInfraCategory(effectiveCategory) || mac.startsWith('66:62:8B:');

        let candidateUpBytes = 0;
        if (prev && !gapTooLarge && isOnline) {
          const prevUp = prev.up_speed_bps;
          if (wanTickUpCeilingBytes !== null) {
            candidateUpBytes = isLocalCameraOrBridge ? 0 : Math.round(((prevUp + upSpeed) / 2) * dtSec);
          } else {
            candidateUpBytes = Math.round(Math.min(prevUp, upSpeed) * dtSec);
          }
          const upBoundBytesPerSec = Math.max(prevUp, upSpeed);
          const maxBytesThisCycle = Math.round(upBoundBytesPerSec * dtSec * 1.1);
          if (candidateUpBytes > maxBytesThisCycle) {
            candidateUpBytes = maxBytesThisCycle;
          }
          if (candidateUpBytes > 5 * 1024 * 1024 * 1024) {
            candidateUpBytes = 0;
          }
        }

        prepared.push({
          dev,
          mac,
          isNew,
          oui,
          guessedCategory,
          isOnline,
          cleanIp,
          upSpeed,
          downSpeed,
          downSumKb,
          sessions,
          onlineMinutes,
          onlineSecondsForStorage,
          wifi,
          prev,
          dtSec,
          gapTooLarge,
          sessionRestarted,
          deltaDownBytes,
          sessionCounterBaseKb,
          candidateUpBytes,
          isLocalCameraOrBridge,
        });
      }

      // Scale total client upload down to true WAN upload ceiling whenever LAN/camera hairpins exceed WAN flux
      const sumCandidateUp = prepared.reduce((s, r) => s + r.candidateUpBytes, 0);
      const upScale =
        wanTickUpCeilingBytes !== null && sumCandidateUp > wanTickUpCeilingBytes && sumCandidateUp > 0
          ? wanTickUpCeilingBytes / sumCandidateUp
          : 1;

      for (const row of prepared) {
        const deltaUpBytes = Math.max(0, Math.round(row.candidateUpBytes * upScale));
        const deltaDownBytes =
          row.isLocalCameraOrBridge && wanTickUpCeilingBytes !== null && row.mac.startsWith('66:62:8B:')
            ? 0
            : row.deltaDownBytes;

        this.updateSession(
          row.mac,
          now,
          row.isOnline,
          row.onlineMinutes,
          row.sessionRestarted,
          deltaDownBytes,
          deltaUpBytes,
          row.downSumKb,
          row.sessionCounterBaseKb,
        );

        this.insertSample.run({
          mac: row.mac,
          ts: now,
          ip: row.cleanIp,
          online: row.isOnline ? 1 : 0,
          up_speed_bps: row.upSpeed,
          down_speed_bps: row.downSpeed,
          down_sum_kb: row.downSumKb,
          sessions: row.sessions,
          online_seconds: row.onlineSecondsForStorage,
          connect_type: row.wifi.connectType,
          connection_kind: row.wifi.connectionKind,
          wifi_band: row.wifi.wifiBand,
          wifi_rssi_dbm: row.wifi.wifiRssiDbm,
          wifi_signal_percent: row.wifi.wifiSignalPercent,
          wifi_distance_m: row.wifi.wifiDistanceM,
          wifi_distance_source: row.wifi.wifiDistanceSource,
        });

        const bucket = bucket5Min(now);
        const activeSec = row.prev && !row.gapTooLarge && row.isOnline ? row.dtSec : 0;
        this.upsertBucket.run({
          mac: row.mac,
          bucket_ts: bucket,
          bytes_down: Math.max(0, deltaDownBytes),
          bytes_up: Math.max(0, deltaUpBytes),
          speed_down: row.downSpeed,
          speed_up: row.upSpeed,
          active_sec: activeSec,
        });

        totalDown += deltaDownBytes;
        totalUp += deltaUpBytes;

        if (row.isNew) {
          enqueueNewDeviceForAutoQos(
            this.db,
            row.mac,
            Math.max(0, Math.round(Number((row.dev as any).hostDownloadLimit ?? 0) || 0)),
            Math.max(0, Math.round(Number((row.dev as any).hostUploadLimit ?? 0) || 0)),
            now,
          );
          insertAlertIfAllowed(this.db, 'new_device', row.mac, {
            mac: row.mac,
            hostname: row.dev.hostName,
            ip: row.cleanIp,
            vendor: row.oui.vendor,
            category: row.guessedCategory,
            router_id: row.dev.ID,
            router_remark: row.dev.hostRemark || null,
            connect_type: row.wifi.connectType,
            connection_kind: row.wifi.connectionKind,
            wifi_band: row.wifi.wifiBand,
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
