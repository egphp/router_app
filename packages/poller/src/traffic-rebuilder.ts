import type Database from 'better-sqlite3';
import { bucket5Min, bucketHour, bucketDay, bucketMonth, isLocalInfraCategory } from '@tenda/shared';
import { isTendaCounterSentinelKb } from './accumulator.js';

interface RawSample {
  mac: string;
  ts: number;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  down_sum_kb: number;
  online_seconds: number | null;
}

interface PrevSample {
  ts: number;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  down_sum_kb: number;
  online_seconds: number | null;
}

interface BucketAccum {
  mac: string;
  bucket_ts: number;
  bytes_down: number;
  bytes_up: number;
  active_sec: number;
  sample_count: number;
  speed_down_total: number;
  speed_up_total: number;
  peak_down_bps: number;
  peak_up_bps: number;
}

interface SessionAccum {
  mac: string;
  started_at: number;
  ended_at: number | null;
  bytes_down: number;
  bytes_up: number;
  down_counter_base_kb: number;
}

export interface RebuildTrafficResult {
  rawSamples: number;
  firstSampleTs: number | null;
  lastSampleTs: number | null;
  normalizedSpeedRows: number;
  deviceSessionRows: number;
  traffic5minRows: number;
  trafficHourRows: number;
  trafficDayRows: number;
  trafficMonthRows: number;
  bytesDown: number;
  bytesUp: number;
}

export interface RebuildTrafficOptions {
  now?: number;
  normalizeSpeeds?: boolean;
  replaceAll?: boolean;
}

export function normalizeStoredSpeed(value: number): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Older builds stored Tenda's integer KB/s value directly in the *_bps columns.
  // Current builds store canonical bytes/sec, so non-zero values below 1024 are legacy.
  if (n < 1024) return Math.round(n * 1024);
  return Math.round(n);
}

export function rebuildTrafficFromSamples(
  db: Database.Database,
  opts: RebuildTrafficOptions = {},
): RebuildTrafficResult {
  const now = opts.now ?? Date.now();
  const normalizeSpeeds = opts.normalizeSpeeds ?? true;
  // Safe default: windowed rebuild preserving historical rollups older than firstSampleTs
  // (since samples_raw is pruned to ~48h). Pass replaceAll: true ONLY for full test/fresh wipes.
  const replaceAll = opts.replaceAll ?? false;

  let normalizedSpeedRows = 0;
  if (normalizeSpeeds) {
    const down = db.prepare(`
      UPDATE samples_raw SET down_speed_bps = down_speed_bps * 1024
      WHERE down_speed_bps > 0 AND down_speed_bps < 1024
    `).run();
    const up = db.prepare(`
      UPDATE samples_raw SET up_speed_bps = up_speed_bps * 1024
      WHERE up_speed_bps > 0 AND up_speed_bps < 1024
    `).run();
    normalizedSpeedRows = Number(down.changes ?? 0) + Number(up.changes ?? 0);
  }

  const samples = db.prepare(`
    SELECT mac, ts, online, up_speed_bps, down_speed_bps, down_sum_kb, online_seconds
    FROM samples_raw
    ORDER BY mac, ts
  `).all() as RawSample[];

  // Optional device category + WAN 5-minute upload ceilings when available in full DB
  const categoryByMac = new Map<string, string | null>();
  try {
    const devRows = db.prepare(`SELECT mac, category FROM devices`).all() as Array<{ mac: string; category: string | null }>;
    for (const d of devRows) categoryByMac.set(d.mac.toUpperCase(), d.category);
  } catch {}

  const wanUpBy5Min = new Map<number, number>();
  try {
    const wanRows = db.prepare(`SELECT bucket_ts, bytes_up FROM wan_traffic_5min`).all() as Array<{ bucket_ts: number; bytes_up: number }>;
    for (const w of wanRows) wanUpBy5Min.set(Number(w.bucket_ts), Number(w.bytes_up ?? 0));
  } catch {}

  const fiveMin = new Map<string, BucketAccum>();
  const sessions: SessionAccum[] = [];
  let openSession: SessionAccum | null = null;
  let currentMac: string | null = null;
  let prev: PrevSample | null = null;
  let bytesDown = 0;
  let bytesUp = 0;
  let firstSampleTs: number | null = null;
  let lastSampleTs: number | null = null;

  for (const sample of samples) {
    firstSampleTs = firstSampleTs == null ? sample.ts : Math.min(firstSampleTs, sample.ts);
    lastSampleTs = lastSampleTs == null ? sample.ts : Math.max(lastSampleTs, sample.ts);

    if (sample.mac !== currentMac) {
      if (openSession) {
        sessions.push(openSession);
        openSession = null;
      }
      currentMac = sample.mac;
      prev = null;
    }

    const upSpeed = normalizeStoredSpeed(sample.up_speed_bps);
    const downSpeed = normalizeStoredSpeed(sample.down_speed_bps);
    let rawDownSumKb = Math.max(0, Number(sample.down_sum_kb ?? 0));
    if (isTendaCounterSentinelKb(rawDownSumKb) || (sample.online === 0 && prev)) {
      rawDownSumKb = prev ? prev.down_sum_kb : 0;
    }
    const dtSec = prev ? Math.max(1, Math.round((sample.ts - prev.ts) / 1000)) : 30;
    const gapTooLarge = dtSec > 5 * 60;
    const onlineMinutes = Number(sample.online_seconds ?? 0);
    const reconnected = Boolean(prev && prev.online === 0 && sample.online === 1);
    const uptimeReset = Boolean(
      prev &&
      onlineMinutes > 0 &&
      Number(prev.online_seconds ?? 0) > 0 &&
      onlineMinutes < Number(prev.online_seconds ?? 0)
    );
    const sessionRestarted = reconnected || uptimeReset;

    let downSumKb = rawDownSumKb;
    let counterNoise = false;
    let realCounterReset = false;
    if (prev && !gapTooLarge && rawDownSumKb < prev.down_sum_kb) {
      if (sessionRestarted) {
        realCounterReset = true;
      } else {
        downSumKb = prev.down_sum_kb;
        counterNoise = true;
      }
    }

    const maxLineKbs = Math.max(25_600, Math.round(((prev?.down_speed_bps ?? 0) + downSpeed) / 2048) * 4);
    const maxPlausibleTickKb = Math.max(64 * 1024, maxLineKbs * dtSec);
    const isRepeaterProxyMac = sample.mac.toUpperCase().startsWith('66:62:8B:');
    const isLocalInfra = isLocalInfraCategory(categoryByMac.get(sample.mac.toUpperCase())) || isRepeaterProxyMac;

    let deltaDownBytes = 0;
    let rebaselinedStaleReset = false;
    if (!prev) {
      deltaDownBytes = 0;
    } else if (gapTooLarge) {
      deltaDownBytes = 0;
    } else if (counterNoise) {
      deltaDownBytes = 0;
    } else if (realCounterReset) {
      if (downSumKb <= maxPlausibleTickKb) {
        deltaDownBytes = downSumKb * 1024;
      } else {
        deltaDownBytes = Math.round(((prev.down_speed_bps + downSpeed) / 2) * dtSec);
        rebaselinedStaleReset = true;
      }
    } else {
      const rawDeltaKb = downSumKb - prev.down_sum_kb;
      if (rawDeltaKb > 5 * 1024 * 1024 || (dtSec <= 90 && rawDeltaKb > Math.max(512 * 1024, maxPlausibleTickKb * 2))) {
        deltaDownBytes = Math.round(((prev.down_speed_bps + downSpeed) / 2) * dtSec);
      } else {
        deltaDownBytes = Math.max(0, rawDeltaKb * 1024);
      }
    }
    if (isRepeaterProxyMac && wanUpBy5Min.size > 0) {
      deltaDownBytes = 0;
    }

    const seedSessionFromCounter = (!sessionRestarted || realCounterReset) && !rebaselinedStaleReset;
    const sessionCounterBaseKb = seedSessionFromCounter
      ? 0
      : Math.max(0, rebaselinedStaleReset ? downSumKb : Number(prev?.down_sum_kb ?? downSumKb));

    let deltaUpBytes = 0;
    if (prev && !gapTooLarge && sample.online === 1) {
      if (isLocalInfra && wanUpBy5Min.size > 0) {
        deltaUpBytes = 0;
      } else {
        deltaUpBytes = Math.round(((prev.up_speed_bps + upSpeed) / 2) * dtSec);
      }
      if (deltaUpBytes > 5 * 1024 * 1024 * 1024) deltaUpBytes = 0;
    }

    const activeSec = prev && !gapTooLarge && sample.online === 1 ? dtSec : 0;
    if (sample.online === 1) {
      if (openSession && sessionRestarted) {
        openSession.ended_at = sample.ts;
        sessions.push(openSession);
        openSession = null;
      }
      if (!openSession) {
        openSession = {
          mac: sample.mac,
          started_at: inferSessionStart(sample.ts, onlineMinutes),
          ended_at: null,
          bytes_down: 0,
          bytes_up: 0,
          down_counter_base_kb: sessionCounterBaseKb,
        };
      }
      const counterFloorBytes = Math.max(0, (downSumKb - openSession.down_counter_base_kb) * 1024);
      openSession.bytes_down = Math.max(
        openSession.bytes_down + Math.max(0, deltaDownBytes),
        counterFloorBytes,
      );
      openSession.bytes_up += Math.max(0, deltaUpBytes);
    } else if (openSession) {
      openSession.ended_at = sample.ts;
      sessions.push(openSession);
      openSession = null;
    }

    addBucket(fiveMin, sample.mac, bucket5Min(sample.ts), {
      bytesDown: deltaDownBytes,
      bytesUp: deltaUpBytes,
      activeSec,
      downSpeed,
      upSpeed,
    });

    bytesDown += deltaDownBytes;
    bytesUp += deltaUpBytes;
    prev = {
      ts: sample.ts,
      online: sample.online,
      up_speed_bps: upSpeed,
      down_speed_bps: downSpeed,
      down_sum_kb: downSumKb,
      online_seconds: onlineMinutes,
    };
  }
  if (openSession) sessions.push(openSession);

  // Scale each 5-minute bucket's device upload total down to actual WAN 5-minute upload when WAN data exists,
  // eliminating local Frigate/HomeKit LAN camera streaming from historical device upload buckets!
  if (wanUpBy5Min.size > 0) {
    const sumUpBy5Min = new Map<number, number>();
    for (const b of fiveMin.values()) {
      sumUpBy5Min.set(b.bucket_ts, (sumUpBy5Min.get(b.bucket_ts) ?? 0) + b.bytes_up);
    }
    bytesUp = 0;
    for (const b of fiveMin.values()) {
      const wanUp = wanUpBy5Min.get(b.bucket_ts);
      const sumUp = sumUpBy5Min.get(b.bucket_ts) ?? 0;
      if (wanUp !== undefined && sumUp > wanUp && sumUp > 0) {
        b.bytes_up = Math.round(b.bytes_up * (wanUp / sumUp));
      }
      bytesUp += b.bytes_up;
    }
  }

  const keep5min = new Map<string, BucketAccum>();
  const hours = new Map<string, BucketAccum>();
  const cutoffHour = bucketHour(now);
  for (const b of fiveMin.values()) {
    if (b.bucket_ts < cutoffHour) addPromotedBucket(hours, b, bucketHour(b.bucket_ts));
    else keep5min.set(bucketKey(b.mac, b.bucket_ts), b);
  }

  const days = new Map<string, BucketAccum>();
  const cutoffDay = bucketDay(now);
  for (const b of hours.values()) {
    if (b.bucket_ts < cutoffDay) addPromotedBucket(days, b, bucketDay(b.bucket_ts));
  }

  const months = new Map<string, BucketAccum>();
  const cutoffMonth = bucketMonth(now);
  for (const b of days.values()) {
    if (b.bucket_ts < cutoffMonth) addPromotedBucket(months, b, bucketMonth(b.bucket_ts));
  }

  const insert5min = db.prepare(`
    INSERT OR REPLACE INTO traffic_5min (
      mac, bucket_ts, bytes_down, bytes_up, avg_down_bps, avg_up_bps,
      peak_down_bps, peak_up_bps, active_sec, sample_count
    ) VALUES (
      @mac, @bucket_ts, @bytes_down, @bytes_up, @avg_down_bps, @avg_up_bps,
      @peak_down_bps, @peak_up_bps, @active_sec, @sample_count
    )
  `);
  const insertCoarse = (table: string) => db.prepare(`
    INSERT OR REPLACE INTO ${table} (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
    VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
  `);
  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO device_sessions (
      mac, started_at, ended_at, bytes_down, bytes_up, down_counter_base_kb
    )
    VALUES (
      @mac, @started_at, @ended_at, @bytes_down, @bytes_up, @down_counter_base_kb
    )
  `);

  let dayRowsWritten = days.size;
  let monthRowsWritten = months.size;

  const txn = db.transaction(() => {
    if (replaceAll) {
      db.prepare(`DELETE FROM traffic_5min`).run();
      db.prepare(`DELETE FROM traffic_hour`).run();
      db.prepare(`DELETE FROM traffic_day`).run();
      db.prepare(`DELETE FROM traffic_month`).run();
      db.prepare(`DELETE FROM device_sessions`).run();
    } else if (firstSampleTs !== null) {
      const min5 = bucket5Min(firstSampleTs);
      const minHour = bucketHour(firstSampleTs);
      db.prepare(`DELETE FROM traffic_5min WHERE bucket_ts >= ?`).run(min5);
      db.prepare(`DELETE FROM traffic_hour WHERE bucket_ts >= ?`).run(minHour);
      db.prepare(`DELETE FROM device_sessions WHERE started_at >= ? OR ended_at IS NULL`).run(firstSampleTs);
    } else {
      // Zero raw samples and replaceAll=false: preserve all existing rollups untouched.
      dayRowsWritten = 0;
      monthRowsWritten = 0;
      return;
    }

    for (const b of keep5min.values()) {
      insert5min.run({
        mac: b.mac,
        bucket_ts: b.bucket_ts,
        bytes_down: Math.round(b.bytes_down),
        bytes_up: Math.round(b.bytes_up),
        avg_down_bps: b.sample_count > 0 ? Math.round(b.speed_down_total / b.sample_count) : 0,
        avg_up_bps: b.sample_count > 0 ? Math.round(b.speed_up_total / b.sample_count) : 0,
        peak_down_bps: b.peak_down_bps,
        peak_up_bps: b.peak_up_bps,
        active_sec: b.active_sec,
        sample_count: b.sample_count,
      });
    }

    const hourInsert = insertCoarse('traffic_hour');
    for (const b of hours.values()) hourInsert.run(coarseParams(b));

    if (replaceAll) {
      const dayInsert = insertCoarse('traffic_day');
      for (const b of days.values()) dayInsert.run(coarseParams(b));
      const monthInsert = insertCoarse('traffic_month');
      for (const b of months.values()) monthInsert.run(coarseParams(b));
    } else if (firstSampleTs !== null) {
      // Re-aggregate affected days from intact pre-window + repaired in-window traffic_hour rows
      // so partial boundary days (e.g. 48h prune mid-day) never lose their earlier hours!
      const minDay = bucketDay(firstSampleTs);
      db.prepare(`DELETE FROM traffic_day WHERE bucket_ts >= ? AND bucket_ts < ?`).run(minDay, cutoffDay);
      const hourRowsForDays = db.prepare(`
        SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec,
               COALESCE(peak_down_bps, 0) AS peak_down_bps,
               COALESCE(peak_up_bps, 0) AS peak_up_bps
        FROM traffic_hour
        WHERE bucket_ts >= ? AND bucket_ts < ?
      `).all(minDay, cutoffDay) as Array<{
        mac: string;
        bucket_ts: number;
        bytes_down: number;
        bytes_up: number;
        active_sec: number;
        peak_down_bps: number;
        peak_up_bps: number;
      }>;
      const mergedDays = new Map<string, BucketAccum>();
      for (const hr of hourRowsForDays) {
        const dBucket = bucketDay(hr.bucket_ts);
        const k = bucketKey(hr.mac, dBucket);
        const acc = mergedDays.get(k) ?? emptyBucket(hr.mac, dBucket);
        acc.bytes_down += Number(hr.bytes_down ?? 0);
        acc.bytes_up += Number(hr.bytes_up ?? 0);
        acc.active_sec += Number(hr.active_sec ?? 0);
        acc.peak_down_bps = Math.max(acc.peak_down_bps, Number(hr.peak_down_bps ?? 0));
        acc.peak_up_bps = Math.max(acc.peak_up_bps, Number(hr.peak_up_bps ?? 0));
        mergedDays.set(k, acc);
      }
      const dayInsert = insertCoarse('traffic_day');
      for (const b of mergedDays.values()) dayInsert.run(coarseParams(b));
      dayRowsWritten = mergedDays.size;

      const minMonth = bucketMonth(firstSampleTs);
      db.prepare(`DELETE FROM traffic_month WHERE bucket_ts >= ? AND bucket_ts < ?`).run(minMonth, cutoffMonth);
      const dayRowsForMonths = db.prepare(`
        SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec,
               COALESCE(peak_down_bps, 0) AS peak_down_bps,
               COALESCE(peak_up_bps, 0) AS peak_up_bps
        FROM traffic_day
        WHERE bucket_ts >= ? AND bucket_ts < ?
      `).all(minMonth, cutoffMonth) as Array<{
        mac: string;
        bucket_ts: number;
        bytes_down: number;
        bytes_up: number;
        active_sec: number;
        peak_down_bps: number;
        peak_up_bps: number;
      }>;
      const mergedMonths = new Map<string, BucketAccum>();
      for (const dy of dayRowsForMonths) {
        const mBucket = bucketMonth(dy.bucket_ts);
        const k = bucketKey(dy.mac, mBucket);
        const acc = mergedMonths.get(k) ?? emptyBucket(dy.mac, mBucket);
        acc.bytes_down += Number(dy.bytes_down ?? 0);
        acc.bytes_up += Number(dy.bytes_up ?? 0);
        acc.active_sec += Number(dy.active_sec ?? 0);
        acc.peak_down_bps = Math.max(acc.peak_down_bps, Number(dy.peak_down_bps ?? 0));
        acc.peak_up_bps = Math.max(acc.peak_up_bps, Number(dy.peak_up_bps ?? 0));
        mergedMonths.set(k, acc);
      }
      const monthInsert = insertCoarse('traffic_month');
      for (const b of mergedMonths.values()) monthInsert.run(coarseParams(b));
      monthRowsWritten = mergedMonths.size;
    }

    for (const session of sessions) {
      insertSession.run({
        ...session,
        bytes_down: Math.round(session.bytes_down),
        bytes_up: Math.round(session.bytes_up),
        down_counter_base_kb: Math.round(session.down_counter_base_kb),
      });
    }
  });
  txn();

  return {
    rawSamples: samples.length,
    firstSampleTs,
    lastSampleTs,
    normalizedSpeedRows,
    deviceSessionRows: sessions.length,
    traffic5minRows: keep5min.size,
    trafficHourRows: hours.size,
    trafficDayRows: dayRowsWritten,
    trafficMonthRows: monthRowsWritten,
    bytesDown,
    bytesUp,
  };
}

function bucketKey(mac: string, bucketTs: number): string {
  return `${mac}|${bucketTs}`;
}

function inferSessionStart(ts: number, onlineMinutes: number): number {
  const minutes = Number.isFinite(onlineMinutes) && onlineMinutes > 0 ? onlineMinutes : 0;
  return ts - Math.round(minutes * 60_000);
}

function emptyBucket(mac: string, bucketTs: number): BucketAccum {
  return {
    mac,
    bucket_ts: bucketTs,
    bytes_down: 0,
    bytes_up: 0,
    active_sec: 0,
    sample_count: 0,
    speed_down_total: 0,
    speed_up_total: 0,
    peak_down_bps: 0,
    peak_up_bps: 0,
  };
}

function addBucket(
  buckets: Map<string, BucketAccum>,
  mac: string,
  bucketTs: number,
  values: { bytesDown: number; bytesUp: number; activeSec: number; downSpeed: number; upSpeed: number },
): void {
  const key = bucketKey(mac, bucketTs);
  const b = buckets.get(key) ?? emptyBucket(mac, bucketTs);
  b.bytes_down += values.bytesDown;
  b.bytes_up += values.bytesUp;
  b.active_sec += values.activeSec;
  b.sample_count += 1;
  b.speed_down_total += values.downSpeed;
  b.speed_up_total += values.upSpeed;
  b.peak_down_bps = Math.max(b.peak_down_bps, values.downSpeed);
  b.peak_up_bps = Math.max(b.peak_up_bps, values.upSpeed);
  buckets.set(key, b);
}

function addPromotedBucket(buckets: Map<string, BucketAccum>, source: BucketAccum, bucketTs: number): void {
  const key = bucketKey(source.mac, bucketTs);
  const b = buckets.get(key) ?? emptyBucket(source.mac, bucketTs);
  b.bytes_down += source.bytes_down;
  b.bytes_up += source.bytes_up;
  b.active_sec += source.active_sec;
  b.sample_count += source.sample_count;
  b.speed_down_total += source.speed_down_total;
  b.speed_up_total += source.speed_up_total;
  b.peak_down_bps = Math.max(b.peak_down_bps, source.peak_down_bps);
  b.peak_up_bps = Math.max(b.peak_up_bps, source.peak_up_bps);
  buckets.set(key, b);
}

function coarseParams(b: BucketAccum) {
  return {
    mac: b.mac,
    bucket_ts: b.bucket_ts,
    bytes_down: Math.round(b.bytes_down),
    bytes_up: Math.round(b.bytes_up),
    active_sec: b.active_sec,
    peak_down_bps: b.peak_down_bps,
    peak_up_bps: b.peak_up_bps,
  };
}
