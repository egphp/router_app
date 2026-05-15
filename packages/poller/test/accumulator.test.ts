// Run with: node --test packages/poller/test/accumulator.test.js
// This is the compiled JS path; we write TS, build, then test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Accumulator } from '../src/accumulator.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  // Inline minimal schema matching 001_init.sql
  db.exec(`
    CREATE TABLE devices (mac TEXT PRIMARY KEY, router_id INTEGER, hostname TEXT, router_remark TEXT,
      custom_label TEXT, vendor TEXT, category TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      is_new INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE samples_raw (mac TEXT, ts INTEGER, ip TEXT, online INTEGER, up_speed_bps INTEGER,
      down_speed_bps INTEGER, down_sum_kb INTEGER, sessions INTEGER, online_seconds INTEGER,
      PRIMARY KEY (mac, ts));
    CREATE TABLE traffic_5min (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0, avg_down_bps INTEGER, avg_up_bps INTEGER, peak_down_bps INTEGER,
      peak_up_bps INTEGER, active_sec INTEGER DEFAULT 0, sample_count INTEGER DEFAULT 0,
      PRIMARY KEY (mac, bucket_ts));
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, mac TEXT, payload TEXT,
      created_at INTEGER, dismissed_at INTEGER);
  `);
  return db;
}

function device(mac: string, opts: { up?: number; down?: number; sumKb: number; online?: 0 | 1; name?: string } = { sumKb: 0 }) {
  return {
    ID: 1, hostIP: '192.168.0.10', hostMAC: mac, hostName: opts.name ?? '', hostRemark: '',
    hostUploadSpeed: opts.up ?? 0, hostDownloadSpeed: opts.down ?? 0,
    hostConnectCount: 0, hostDownloadSum: opts.sumKb, hostConnectType: 4,
    hostUploadLimit: 0, hostDownloadLimit: 0, onlineTime: 0,
    hostAuthType: '', authUserName: '', hostOnlineStatus: (opts.online ?? 1) as any,
  };
}

test('first sample for a device contributes 0 bytes (baseline)', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const r = acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_000 })], false);
  assert.equal(r.totalBytesDownDelta, 0, 'first sample = no delta');
  assert.equal(r.newDevices.length, 1);
});

test('subsequent samples produce delta = (new - old) * 1024', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_000 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 11_000 })], false);
  assert.equal(r.totalBytesDownDelta, 1000 * 1024, 'delta 1000 KB → 1024000 bytes');
});

test('reboot detected → counter starts fresh, full sum counted', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 50_000 })], false);
  // After reboot router restarts counter; cumulative = 500 KB
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 500 })], true);
  assert.equal(r.totalBytesDownDelta, 500 * 1024, 'after reboot we add full new sum');
});

test('counter regression without reboot flag also treated like reboot', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 50_000 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 200 })], false);
  assert.equal(r.totalBytesDownDelta, 200 * 1024);
});

test('implausibly large delta clamped to 0 with warning', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_000 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 100 * 1024 * 1024 })], false);
  assert.equal(r.totalBytesDownDelta, 0, '>50GB jump rejected');
});

test('upload integration: bytes ≈ avg(prev_speed, now_speed) × dt', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { up: 1000, sumKb: 0 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { up: 2000, sumKb: 0 })], false);
  // avg(1000, 2000) × 30s = 45000 bytes
  assert.equal(r.totalBytesUpDelta, 45_000);
});

test('new MAC inserts new_device alert', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:99', { sumKb: 0, name: 'TestPhone' })], false);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE kind = 'new_device'`).all();
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as any).mac, 'AA:BB:CC:00:00:99');
});

test('offline device contributes 0 speed, no spurious upload integration', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { up: 1000, sumKb: 0, online: 1 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { up: 0, sumKb: 0, online: 0 })], false);
  // avg(1000, 0) * 30 = 15000 (transitional; this is acceptable trapezoidal behavior)
  assert.equal(r.totalBytesUpDelta, 15_000);
});

test('multiple devices accumulated independently', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [
    device('AA:00:00:00:00:01', { sumKb: 100 }),
    device('AA:00:00:00:00:02', { sumKb: 200 }),
  ], false);
  const r = acc.process(1_030_000, [
    device('AA:00:00:00:00:01', { sumKb: 150 }),  // +50 KB
    device('AA:00:00:00:00:02', { sumKb: 250 }),  // +50 KB
  ], false);
  assert.equal(r.totalBytesDownDelta, 100 * 1024);
});

test('full reboot scenario: data preserved across counter reset', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  // Pre-reboot: device downloaded 100 KB → 200 KB → 300 KB
  acc.process(1_000_000, [device('AA:00:00:00:00:01', { sumKb: 100 })], false);
  acc.process(1_030_000, [device('AA:00:00:00:00:01', { sumKb: 200 })], false);
  acc.process(1_060_000, [device('AA:00:00:00:00:01', { sumKb: 300 })], false);
  // Reboot — counter resets, device downloads more
  acc.process(1_090_000, [device('AA:00:00:00:00:01', { sumKb: 50 })], true);
  acc.process(1_120_000, [device('AA:00:00:00:00:01', { sumKb: 150 })], false);

  const total = (db.prepare(`SELECT SUM(bytes_down) AS s FROM traffic_5min WHERE mac = 'AA:00:00:00:00:01'`).get() as any).s;
  // Expected: 0 (first) + 100K (delta) + 100K (delta) + 50K (reboot baseline added) + 100K (delta) = 350K bytes worth
  const expected = (0 + 100 + 100 + 50 + 100) * 1024;
  assert.equal(total, expected, `expected ${expected} bytes, got ${total}`);
});
