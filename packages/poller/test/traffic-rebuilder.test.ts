import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { bucket5Min, bucketHour } from '@tenda/shared';
import { normalizeStoredSpeed, rebuildTrafficFromSamples } from '../src/traffic-rebuilder.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE samples_raw (
      mac TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ip TEXT,
      online INTEGER NOT NULL,
      up_speed_bps INTEGER NOT NULL,
      down_speed_bps INTEGER NOT NULL,
      down_sum_kb INTEGER NOT NULL,
      sessions INTEGER,
      online_seconds INTEGER,
      PRIMARY KEY (mac, ts)
    );
    CREATE TABLE traffic_5min (
      mac TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      bytes_down INTEGER NOT NULL DEFAULT 0,
      bytes_up INTEGER NOT NULL DEFAULT 0,
      avg_down_bps INTEGER,
      avg_up_bps INTEGER,
      peak_down_bps INTEGER,
      peak_up_bps INTEGER,
      active_sec INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mac, bucket_ts)
    );
    CREATE TABLE traffic_hour (
      mac TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      bytes_down INTEGER NOT NULL DEFAULT 0,
      bytes_up INTEGER NOT NULL DEFAULT 0,
      active_sec INTEGER NOT NULL DEFAULT 0,
      peak_down_bps INTEGER,
      peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts)
    );
    CREATE TABLE traffic_day (
      mac TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      bytes_down INTEGER NOT NULL DEFAULT 0,
      bytes_up INTEGER NOT NULL DEFAULT 0,
      active_sec INTEGER NOT NULL DEFAULT 0,
      peak_down_bps INTEGER,
      peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts)
    );
    CREATE TABLE traffic_month (
      mac TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      bytes_down INTEGER NOT NULL DEFAULT 0,
      bytes_up INTEGER NOT NULL DEFAULT 0,
      active_sec INTEGER NOT NULL DEFAULT 0,
      peak_down_bps INTEGER,
      peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts)
    );
    CREATE TABLE device_sessions (
      mac TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0,
      down_counter_base_kb INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mac, started_at)
    );
  `);
  return db;
}

function insertSample(db: Database.Database, ts: number, opts: {
  mac?: string;
  sumKb: number;
  down?: number;
  up?: number;
  online?: 0 | 1;
  onlineMinutes?: number;
}) {
  db.prepare(`
    INSERT INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, sessions, online_seconds)
    VALUES (?, ?, '192.168.0.10', ?, ?, ?, ?, 0, ?)
  `).run(opts.mac ?? 'AA:BB:CC:00:00:01', ts, opts.online ?? 1, opts.up ?? 0, opts.down ?? 0, opts.sumKb, opts.onlineMinutes ?? 0);
}

test('normalizeStoredSpeed converts legacy KB/s values once', () => {
  assert.equal(normalizeStoredSpeed(0), 0);
  assert.equal(normalizeStoredSpeed(3), 3072);
  assert.equal(normalizeStoredSpeed(1024), 1024);
});

test('rebuildTrafficFromSamples reconstructs hourly and live buckets from raw samples', () => {
  const db = makeDb();
  const oldHour = new Date(2026, 4, 15, 10, 0, 0).getTime();
  insertSample(db, oldHour, { sumKb: 100, down: 1, up: 1 });
  insertSample(db, oldHour + 30_000, { sumKb: 200, down: 3, up: 3 });
  insertSample(db, oldHour + 60_000, { sumKb: 0, down: 0, up: 0 });
  insertSample(db, oldHour + 90_000, { sumKb: 50, down: 1, up: 1 });
  insertSample(db, oldHour + 120_000, { sumKb: 200, down: 2, up: 2 });
  insertSample(db, oldHour + 150_000, { sumKb: 260, down: 4, up: 4 });

  const liveHour = new Date(2026, 4, 15, 23, 5, 0).getTime();
  insertSample(db, liveHour, { sumKb: 400, down: 8, up: 8 });
  insertSample(db, liveHour + 30_000, { sumKb: 500, down: 10, up: 10 });

  const result = rebuildTrafficFromSamples(db, {
    now: new Date(2026, 4, 15, 23, 30, 0).getTime(),
    normalizeSpeeds: true,
    replaceAll: true,
  });

  assert.equal(result.rawSamples, 8);
  assert.equal(result.trafficHourRows, 1);
  assert.equal(result.traffic5minRows, 1);

  const hour = db.prepare(`SELECT * FROM traffic_hour WHERE mac = ?`).get('AA:BB:CC:00:00:01') as any;
  assert.equal(hour.bucket_ts, bucketHour(oldHour));
  assert.equal(hour.bytes_down, 160 * 1024);
  assert.equal(hour.active_sec, 150);
  assert.equal(hour.peak_down_bps, 4 * 1024);

  const live = db.prepare(`SELECT * FROM traffic_5min WHERE mac = ?`).get('AA:BB:CC:00:00:01') as any;
  assert.equal(live.bucket_ts, bucket5Min(liveHour));
  assert.equal(live.bytes_down, 100 * 1024);
  assert.equal(live.sample_count, 2);
  assert.equal(live.avg_down_bps, 9 * 1024);
});

test('rebuildTrafficFromSamples reconstructs device sessions from raw samples', () => {
  const db = makeDb();
  const t = new Date(2026, 4, 15, 12, 0, 0).getTime();
  insertSample(db, t, { sumKb: 1_000, onlineMinutes: 10 });
  insertSample(db, t + 30_000, { sumKb: 1_100, up: 2, onlineMinutes: 11 });
  insertSample(db, t + 60_000, { sumKb: 1_100, online: 0 });
  insertSample(db, t + 90_000, { sumKb: 50, onlineMinutes: 1 });
  insertSample(db, t + 120_000, { sumKb: 90, up: 4, onlineMinutes: 2 });

  const result = rebuildTrafficFromSamples(db, {
    now: t + 10 * 60_000,
    normalizeSpeeds: true,
    replaceAll: true,
  });

  assert.equal(result.deviceSessionRows, 2);
  const sessions = db.prepare(`SELECT started_at, ended_at, bytes_down, bytes_up FROM device_sessions ORDER BY started_at`)
    .all() as Array<{ started_at: number; ended_at: number | null; bytes_down: number; bytes_up: number }>;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].started_at, t - 10 * 60_000);
  assert.equal(sessions[0].ended_at, t + 60_000);
  assert.equal(sessions[0].bytes_down, 1_100 * 1024);
  assert.equal(sessions[1].started_at, t + 90_000 - 60_000);
  assert.equal(sessions[1].ended_at, null);
  assert.equal(sessions[1].bytes_down, 90 * 1024);
});

test('rebuildTrafficFromSamples does not duplicate cumulative counters across reconnects', () => {
  const db = makeDb();
  const t = new Date(2026, 4, 15, 12, 0, 0).getTime();
  insertSample(db, t, { sumKb: 10_000, onlineMinutes: 10 });
  insertSample(db, t + 30_000, { sumKb: 10_000, online: 0 });
  insertSample(db, t + 60_000, { sumKb: 10_000, onlineMinutes: 1 });
  insertSample(db, t + 90_000, { sumKb: 10_050, onlineMinutes: 2 });

  rebuildTrafficFromSamples(db, {
    now: t + 10 * 60_000,
    normalizeSpeeds: true,
    replaceAll: true,
  });

  const sessions = db.prepare(`SELECT bytes_down FROM device_sessions ORDER BY started_at`)
    .all() as Array<{ bytes_down: number }>;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].bytes_down, 10_000 * 1024);
  assert.equal(sessions[1].bytes_down, 50 * 1024);
});

test('rebuildTrafficFromSamples uses counter baseline after offline zero reconnects', () => {
  const db = makeDb();
  const t = new Date(2026, 4, 15, 12, 0, 0).getTime();
  insertSample(db, t, { sumKb: 10_000, onlineMinutes: 10 });
  insertSample(db, t + 30_000, { sumKb: 0, online: 0 });
  insertSample(db, t + 60_000, { sumKb: 10_000, onlineMinutes: 1 });
  insertSample(db, t + 90_000, { sumKb: 10_050, onlineMinutes: 2 });

  rebuildTrafficFromSamples(db, {
    now: t + 10 * 60_000,
    normalizeSpeeds: true,
    replaceAll: true,
  });

  const sessions = db.prepare(`SELECT bytes_down, down_counter_base_kb FROM device_sessions ORDER BY started_at`)
    .all() as Array<{ bytes_down: number; down_counter_base_kb: number }>;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].bytes_down, 10_000 * 1024);
  assert.equal(sessions[1].down_counter_base_kb, 10_000);
  assert.equal(sessions[1].bytes_down, 50 * 1024);
});

test('rebuildTrafficFromSamples treats offline to online as a new baseline without onlineTime', () => {
  const db = makeDb();
  const t = new Date(2026, 4, 15, 12, 0, 0).getTime();
  insertSample(db, t, { sumKb: 10_000 });
  insertSample(db, t + 30_000, { sumKb: 0, online: 0 });
  insertSample(db, t + 60_000, { sumKb: 10_000 });
  insertSample(db, t + 90_000, { sumKb: 10_050 });

  rebuildTrafficFromSamples(db, {
    now: t + 10 * 60_000,
    normalizeSpeeds: true,
    replaceAll: true,
  });

  const sessions = db.prepare(`SELECT bytes_down, down_counter_base_kb FROM device_sessions ORDER BY started_at`)
    .all() as Array<{ bytes_down: number; down_counter_base_kb: number }>;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].bytes_down, 10_000 * 1024);
  assert.equal(sessions[1].down_counter_base_kb, 10_000);
  assert.equal(sessions[1].bytes_down, 50 * 1024);
});

test('rebuildTrafficFromSamples aligns long-gap active sessions to the counter floor', () => {
  const db = makeDb();
  const t = new Date(2026, 4, 15, 12, 0, 0).getTime();
  insertSample(db, t, { sumKb: 10_000, onlineMinutes: 10 });
  insertSample(db, t + 10 * 60_000, { sumKb: 16_000, onlineMinutes: 20 });

  rebuildTrafficFromSamples(db, {
    now: t + 15 * 60_000,
    normalizeSpeeds: true,
    replaceAll: true,
  });

  const session = db.prepare(`SELECT bytes_down FROM device_sessions`).get() as { bytes_down: number };
  const bucketBytes = db.prepare(`SELECT SUM(bytes_down) AS bd FROM traffic_5min`).get() as { bd: number };
  assert.equal(bucketBytes.bd, 0);
  assert.equal(session.bytes_down, 16_000 * 1024);
});
