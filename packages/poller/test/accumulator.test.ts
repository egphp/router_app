// Run with: node --test packages/poller/test/accumulator.test.js
// This is the compiled JS path; we write TS, build, then test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Accumulator } from '../src/accumulator.js';
import { estimateWifiDistanceMeters, extractWifiMetrics } from '../src/wifi-metrics.js';

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
      connect_type INTEGER, connection_kind TEXT, wifi_band TEXT, wifi_rssi_dbm REAL,
      wifi_signal_percent REAL, wifi_distance_m REAL, wifi_distance_source TEXT,
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

function device(
  mac: string,
  opts: { up?: number; down?: number; sumKb: number; online?: 0 | 1; name?: string; onlineTime?: number } = { sumKb: 0 },
) {
  return {
    ID: 1, hostIP: '192.168.0.10', hostMAC: mac, hostName: opts.name ?? '', hostRemark: '',
    hostUploadSpeed: opts.up ?? 0, hostDownloadSpeed: opts.down ?? 0,
    hostConnectCount: 0, hostDownloadSum: opts.sumKb, hostConnectType: 4,
    hostUploadLimit: 0, hostDownloadLimit: 0, onlineTime: opts.onlineTime ?? 0,
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

test('wifi metrics classify Tenda connection types and estimate RSSI distance', () => {
  const metrics = extractWifiMetrics({
    ...device('AA:BB:CC:00:00:01', { sumKb: 0 }),
    hostConnectType: 3,
    rssi: -67,
  } as any);

  assert.equal(metrics.connectionKind, 'wifi');
  assert.equal(metrics.wifiBand, '2.4GHz');
  assert.equal(metrics.wifiRssiDbm, -67);
  assert.equal(metrics.wifiDistanceM, estimateWifiDistanceMeters(-67, '2.4GHz'));
  assert.equal(metrics.wifiDistanceSource, 'rssi-log-distance');
});

test('accumulator persists WiFi metadata with samples', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [{
    ...device('AA:BB:CC:00:00:01', { sumKb: 0 }),
    hostConnectType: 4,
    hostRSSI: '64 dBm',
  } as any], false);

  const row = db.prepare(`
    SELECT connect_type, connection_kind, wifi_band, wifi_rssi_dbm, wifi_distance_m, wifi_distance_source
    FROM samples_raw
    WHERE mac = 'AA:BB:CC:00:00:01'
  `).get() as any;

  assert.equal(row.connect_type, 4);
  assert.equal(row.connection_kind, 'wifi');
  assert.equal(row.wifi_band, '5GHz');
  assert.equal(row.wifi_rssi_dbm, -64);
  assert.equal(row.wifi_distance_m, estimateWifiDistanceMeters(-64, '5GHz'));
  assert.equal(row.wifi_distance_source, 'rssi-log-distance');
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

test('counter regression without a session restart is treated as firmware noise', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 50_000, onlineTime: 100 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 200, onlineTime: 101 })], false);
  assert.equal(r.totalBytesDownDelta, 0);
});

test('counter regression with a lower onlineTime is treated as a new device session', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 50_000, onlineTime: 100 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 200, onlineTime: 1 })], false);
  assert.equal(r.totalBytesDownDelta, 200 * 1024);
});

test('flicker to 0: clamped to prev high-water mark, contributes 0 bytes', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 263 })], false);
  // Firmware flicker: same device reports sum=0 momentarily, then 263 again next tick.
  const r1 = acc.process(1_010_000, [device('AA:BB:CC:00:00:01', { sumKb: 0 })], false);
  assert.equal(r1.totalBytesDownDelta, 0, 'flicker contributes nothing');
  const r2 = acc.process(1_020_000, [device('AA:BB:CC:00:00:01', { sumKb: 263 })], false);
  assert.equal(r2.totalBytesDownDelta, 0, 'no spurious credit after flicker');
});

test('implausibly large delta clamped to 0 with warning', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_000 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 100 * 1024 * 1024 })], false);
  assert.equal(r.totalBytesDownDelta, 0, '>5GB jump rejected');
});

test('upload integration: bytes ≈ avg(prev_speed, now_speed) × dt, with KB/s units', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  // Tenda reports speeds in KB/s (integer). Accumulator stores bytes/s internally.
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { up: 1, sumKb: 0 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { up: 3, sumKb: 0 })], false);
  // avg(1, 3) KB/s = 2 KB/s = 2048 B/s; × 30s = 61440 bytes
  assert.equal(r.totalBytesUpDelta, 2 * 1024 * 30);
});

test('5-minute speed averages include every sample once', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { down: 1, up: 1, sumKb: 0 })], false);
  acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { down: 3, up: 5, sumKb: 1 })], false);
  acc.process(1_060_000, [device('AA:BB:CC:00:00:01', { down: 5, up: 7, sumKb: 2 })], false);

  const row = db.prepare(`
    SELECT sample_count, avg_down_bps, avg_up_bps
    FROM traffic_5min WHERE mac = 'AA:BB:CC:00:00:01'
  `).get() as { sample_count: number; avg_down_bps: number; avg_up_bps: number };
  assert.equal(row.sample_count, 3);
  assert.equal(row.avg_down_bps, 3 * 1024);
  assert.equal(row.avg_up_bps, Math.round((1 + 5 + 7) * 1024 / 3));
});

test('new MAC inserts new_device alert', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:99', { sumKb: 0, name: 'TestPhone' })], false);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE kind = 'new_device'`).all();
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as any).mac, 'AA:BB:CC:00:00:99');
});

test('offline device contributes 0 upload (no integration when offline)', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { up: 1, sumKb: 0, online: 1 })], false);
  // When the device goes offline, we deliberately skip the upload integration to avoid
  // a transitional half-trapezoid spike that overstates traffic during disconnect events.
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { up: 0, sumKb: 0, online: 0 })], false);
  assert.equal(r.totalBytesUpDelta, 0);
});

test('long gaps re-baseline without synthesizing active seconds', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 100, online: 1 })], false);
  acc.process(1_000_000 + 10 * 60_000, [device('AA:BB:CC:00:00:01', { sumKb: 200, online: 1 })], false);
  const total = db.prepare(`
    SELECT COALESCE(SUM(active_sec), 0) AS active_sec, COALESCE(SUM(bytes_down), 0) AS bytes_down
    FROM traffic_5min WHERE mac = 'AA:BB:CC:00:00:01'
  `).get() as { active_sec: number; bytes_down: number };
  assert.equal(total.active_sec, 0);
  assert.equal(total.bytes_down, 0);
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

test('per-session zero (no reboot): flicker absorbed, no double-counting', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  // Real-world: device counter accumulates, then the firmware *flickers* to 0 between
  // samples and returns to the true value. The accumulator must not credit anything for
  // the flicker, since crediting prev+new would inflate totals on every transient zero.
  acc.process(1_000_000, [device('AA:00:00:00:00:01', { sumKb: 100 })], false);
  acc.process(1_030_000, [device('AA:00:00:00:00:01', { sumKb: 263 })], false);  // +163K
  acc.process(1_060_000, [device('AA:00:00:00:00:01', { sumKb: 0 })], false);    // flicker (≤ 64KB; treated as noise)
  acc.process(1_090_000, [device('AA:00:00:00:00:01', { sumKb: 50 })], false);   // ≤ 64KB after a flicker — still treated as noise; the real counter is back to >= 263

  const total = (db.prepare(`SELECT SUM(bytes_down) AS s FROM traffic_5min WHERE mac = 'AA:00:00:00:00:01'`).get() as any).s;
  // Expected: 0 (first) + 163K (real delta) + 0 (flicker absorbed) + 0 (still under flicker threshold)
  const expected = (0 + 163 + 0 + 0) * 1024;
  assert.equal(total, expected, `expected ${expected} bytes, got ${total}`);
});

test('low post-zero flicker preserves high-water mark until the true counter returns', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:00:00:00:00:01', { sumKb: 100 })], false);
  acc.process(1_030_000, [device('AA:00:00:00:00:01', { sumKb: 263 })], false);
  acc.process(1_060_000, [device('AA:00:00:00:00:01', { sumKb: 0 })], false);
  acc.process(1_090_000, [device('AA:00:00:00:00:01', { sumKb: 50 })], false);
  const r = acc.process(1_120_000, [device('AA:00:00:00:00:01', { sumKb: 263 })], false);

  assert.equal(r.totalBytesDownDelta, 0, 'returning to the prior high-water mark is not new traffic');
  const latest = db.prepare(`
    SELECT down_sum_kb FROM samples_raw
    WHERE mac = 'AA:00:00:00:00:01'
    ORDER BY ts DESC LIMIT 1
  `).get() as { down_sum_kb: number };
  assert.equal(latest.down_sum_kb, 263, 'stored sample keeps the high-water counter');
});
