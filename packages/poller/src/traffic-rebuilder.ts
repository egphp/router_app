import type Database from 'better-sqlite3';
import { bucket5Min, bucketHour, bucketDay, bucketMonth } from '@tenda/shared';

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
  up_speed_bps: number;
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

export interface RebuildTrafficResult {
  rawSamples: number;
  firstSampleTs: number | null;
  lastSampleTs: number | null;
  normalizedSpeedRows: number;
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
  const replaceAll = opts.replaceAll ?? true;

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

  const fiveMin = new Map<string, BucketAccum>();
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
      currentMac = sample.mac;
      prev = null;
    }

    const upSpeed = normalizeStoredSpeed(sample.up_speed_bps);
    const downSpeed = normalizeStoredSpeed(sample.down_speed_bps);
    const rawDownSumKb = Math.max(0, Number(sample.down_sum_kb ?? 0));
    const dtSec = prev ? Math.max(1, Math.round((sample.ts - prev.ts) / 1000)) : 30;
    const gapTooLarge = dtSec > 5 * 60;
    const onlineSec = Number(sample.online_seconds ?? 0);
    const sessionRestarted = Boolean(
      prev &&
      onlineSec > 0 &&
      Number(prev.online_seconds ?? 0) > 0 &&
      onlineSec < Number(prev.online_seconds ?? 0)
    );

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

    let deltaDownBytes = 0;
    if (!prev) {
      deltaDownBytes = 0;
    } else if (gapTooLarge) {
      deltaDownBytes = 0;
    } else if (counterNoise) {
      deltaDownBytes = 0;
    } else if (realCounterReset) {
      deltaDownBytes = downSumKb * 1024;
    } else {
      const rawDeltaKb = downSumKb - prev.down_sum_kb;
      deltaDownBytes = rawDeltaKb > 5 * 1024 * 1024 ? 0 : Math.max(0, rawDeltaKb * 1024);
    }

    let deltaUpBytes = 0;
    if (prev && !gapTooLarge && sample.online === 1) {
      deltaUpBytes = Math.round(((prev.up_speed_bps + upSpeed) / 2) * dtSec);
      if (deltaUpBytes > 5 * 1024 * 1024 * 1024) deltaUpBytes = 0;
    }

    const activeSec = prev && !gapTooLarge && sample.online === 1 ? dtSec : 0;
    addBucket(fiveMin, sample.mac, bucket5Min(sample.ts), {
      bytesDown: deltaDownBytes,
      bytesUp: deltaUpBytes,
      activeSec,
      downSpeed,
      upSpeed,
    });

    bytesDown += deltaDownBytes;
    bytesUp += deltaUpBytes;
    prev = { ts: sample.ts, up_speed_bps: upSpeed, down_sum_kb: downSumKb, online_seconds: onlineSec };
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
    INSERT INTO traffic_5min (
      mac, bucket_ts, bytes_down, bytes_up, avg_down_bps, avg_up_bps,
      peak_down_bps, peak_up_bps, active_sec, sample_count
    ) VALUES (
      @mac, @bucket_ts, @bytes_down, @bytes_up, @avg_down_bps, @avg_up_bps,
      @peak_down_bps, @peak_up_bps, @active_sec, @sample_count
    )
  `);
  const insertCoarse = (table: string) => db.prepare(`
    INSERT INTO ${table} (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
    VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
  `);

  const txn = db.transaction(() => {
    if (replaceAll) {
      db.prepare(`DELETE FROM traffic_5min`).run();
      db.prepare(`DELETE FROM traffic_hour`).run();
      db.prepare(`DELETE FROM traffic_day`).run();
      db.prepare(`DELETE FROM traffic_month`).run();
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
    const dayInsert = insertCoarse('traffic_day');
    for (const b of days.values()) dayInsert.run(coarseParams(b));
    const monthInsert = insertCoarse('traffic_month');
    for (const b of months.values()) monthInsert.run(coarseParams(b));
  });
  txn();

  return {
    rawSamples: samples.length,
    firstSampleTs,
    lastSampleTs,
    normalizedSpeedRows,
    traffic5minRows: keep5min.size,
    trafficHourRows: hours.size,
    trafficDayRows: days.size,
    trafficMonthRows: months.size,
    bytesDown,
    bytesUp,
  };
}

function bucketKey(mac: string, bucketTs: number): string {
  return `${mac}|${bucketTs}`;
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
