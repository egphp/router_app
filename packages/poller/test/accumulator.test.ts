// Run with: node --test packages/poller/test/accumulator.test.js
// This is the compiled JS path; we write TS, build, then test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Accumulator } from '../src/accumulator.js';
import { RollupWorker } from '../src/rollup.js';
import { estimateWifiDistanceMeters, extractWifiMetrics } from '../src/wifi-metrics.js';
import { bucketDay } from '@tenda/shared';

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
    CREATE TABLE device_sessions (mac TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
      bytes_down INTEGER DEFAULT 0, bytes_up INTEGER DEFAULT 0,
      down_counter_base_kb INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mac, started_at));
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, mac TEXT, payload TEXT,
      created_at INTEGER, dismissed_at INTEGER);
  `);
  return db;
}

function device(
  mac: string,
  // `onlineTime` is in MINUTES (the unit the Tenda firmware reports).
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

  const session = db.prepare(`SELECT bytes_down FROM device_sessions WHERE mac = ?`)
    .get('AA:BB:CC:00:00:01') as { bytes_down: number };
  assert.equal(session.bytes_down, 10_000 * 1024, 'session total follows router counter');
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

test('open device session is created and accumulates traffic', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_000, onlineTime: 2 })], false);
  acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_100, onlineTime: 3 })], false);

  const row = db.prepare(`SELECT started_at, ended_at, bytes_down FROM device_sessions WHERE mac = ?`)
    .get('AA:BB:CC:00:00:01') as { started_at: number; ended_at: number | null; bytes_down: number };
  // Tenda firmware reports onlineTime in MINUTES (the integer ticks once per
  // wall-clock minute, verified empirically against the open session).
  // started_at = now - onlineMinutes * 60_000.
  assert.equal(row.started_at, 1_000_000 - 2 * 60_000);
  assert.equal(row.ended_at, null);
  assert.equal(row.bytes_down, 10_100 * 1024);
});

test('offline sample closes the open device session', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_000, onlineTime: 2 })], false);
  acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_100, onlineTime: 3 })], false);
  acc.process(1_060_000, [device('AA:BB:CC:00:00:01', { sumKb: 10_100, online: 0 })], false);

  const row = db.prepare(`SELECT ended_at, bytes_down FROM device_sessions WHERE mac = ?`)
    .get('AA:BB:CC:00:00:01') as { ended_at: number | null; bytes_down: number };
  assert.equal(row.ended_at, 1_060_000);
  assert.equal(row.bytes_down, 10_100 * 1024);
});

test('reconnect without router counter reset does not re-credit the cumulative counter', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const mac = 'AA:BB:CC:00:00:01';
  acc.process(1_000_000, [device(mac, { sumKb: 10_000, onlineTime: 10 })], false);
  acc.process(1_030_000, [device(mac, { sumKb: 10_000, online: 0 })], false);
  acc.process(1_060_000, [device(mac, { sumKb: 10_000, onlineTime: 1 })], false);
  acc.process(1_090_000, [device(mac, { sumKb: 10_050, onlineTime: 2 })], false);

  const rows = db.prepare(`SELECT bytes_down FROM device_sessions WHERE mac = ? ORDER BY started_at`)
    .all(mac) as Array<{ bytes_down: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bytes_down, 10_000 * 1024);
  assert.equal(rows[1].bytes_down, 50 * 1024);
});

test('reconnect after an offline zero uses the previous high-water counter as baseline', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const mac = 'AA:BB:CC:00:00:01';
  acc.process(1_000_000, [device(mac, { sumKb: 10_000, onlineTime: 10 })], false);
  acc.process(1_030_000, [device(mac, { sumKb: 0, online: 0 })], false);
  acc.process(1_060_000, [device(mac, { sumKb: 10_000, onlineTime: 1 })], false);
  acc.process(1_090_000, [device(mac, { sumKb: 10_050, onlineTime: 2 })], false);

  const rows = db.prepare(`SELECT bytes_down, down_counter_base_kb FROM device_sessions WHERE mac = ? ORDER BY started_at`)
    .all(mac) as Array<{ bytes_down: number; down_counter_base_kb: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bytes_down, 10_000 * 1024);
  assert.equal(rows[1].down_counter_base_kb, 10_000);
  assert.equal(rows[1].bytes_down, 50 * 1024);
});

test('offline to online starts a new baseline even when onlineTime is unavailable', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const mac = 'AA:BB:CC:00:00:01';
  acc.process(1_000_000, [device(mac, { sumKb: 10_000 })], false);
  acc.process(1_030_000, [device(mac, { sumKb: 0, online: 0 })], false);
  acc.process(1_060_000, [device(mac, { sumKb: 10_000 })], false);
  acc.process(1_090_000, [device(mac, { sumKb: 10_050 })], false);

  const rows = db.prepare(`SELECT bytes_down, down_counter_base_kb FROM device_sessions WHERE mac = ? ORDER BY started_at`)
    .all(mac) as Array<{ bytes_down: number; down_counter_base_kb: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bytes_down, 10_000 * 1024);
  assert.equal(rows[1].down_counter_base_kb, 10_000);
  assert.equal(rows[1].bytes_down, 50 * 1024);
});

test('long gap in the same router session aligns session total to the cumulative counter without bucket delta', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const mac = 'AA:BB:CC:00:00:01';
  acc.process(1_000_000, [device(mac, { sumKb: 10_000, onlineTime: 10 })], false);
  const r = acc.process(1_600_000, [device(mac, { sumKb: 16_000, onlineTime: 20 })], false);

  const session = db.prepare(`SELECT bytes_down FROM device_sessions WHERE mac = ?`)
    .get(mac) as { bytes_down: number };
  const bucketBytes = db.prepare(`SELECT SUM(bytes_down) AS bd FROM traffic_5min WHERE mac = ?`)
    .get(mac) as { bd: number };
  assert.equal(r.totalBytesDownDelta, 0);
  assert.equal(bucketBytes.bd, 0);
  assert.equal(session.bytes_down, 16_000 * 1024);
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

test('upload integration uses min(prev_speed, now_speed) × dt to avoid burst-peak overshoot', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  // Tenda reports speeds in KB/s (integer). Accumulator stores bytes/s internally.
  // We use min-of-pair as a conservative lower-bound integrator. The trapezoidal
  // mean used to extrapolate a single high sample over the whole interval, which
  // could double the true bytes when bursts only existed at the sample instant.
  acc.process(1_000_000, [device('AA:BB:CC:00:00:01', { up: 1, sumKb: 0 })], false);
  const r = acc.process(1_030_000, [device('AA:BB:CC:00:00:01', { up: 3, sumKb: 0 })], false);
  // min(1, 3) KB/s = 1 KB/s = 1024 B/s; × 30s = 30720 bytes
  assert.equal(r.totalBytesUpDelta, 1 * 1024 * 30);
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
  acc.process(1_000_000, [device('AA:BB:CC:00:00:99', { sumKb: 0, name: 'iPhone' })], false);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE kind = 'new_device'`).all();
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as any).mac, 'AA:BB:CC:00:00:99');
  const payload = JSON.parse((alerts[0] as any).payload);
  assert.equal(payload.mac, 'AA:BB:CC:00:00:99');
  assert.equal(payload.hostname, 'iPhone');
  assert.equal(payload.ip, '192.168.0.10');
  assert.equal(payload.category, 'phone');
});

test('deleted MAC is treated as new again on the next sample', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const mac = 'AA:BB:CC:00:00:98';

  const first = acc.process(1_000_000, [device(mac, { sumKb: 0, name: 'TestPhone' })], false);
  assert.deepEqual(first.newDevices, [mac]);

  db.exec(`
    DELETE FROM alerts WHERE mac = '${mac}';
    DELETE FROM samples_raw WHERE mac = '${mac}';
    DELETE FROM traffic_5min WHERE mac = '${mac}';
    DELETE FROM device_sessions WHERE mac = '${mac}';
    DELETE FROM devices WHERE mac = '${mac}';
  `);

  const second = acc.process(1_030_000, [device(mac, { sumKb: 0, name: 'TestPhone' })], false);
  assert.deepEqual(second.newDevices, [mac]);

  const alerts = db.prepare(`SELECT * FROM alerts WHERE kind = 'new_device' AND mac = ?`).all(mac);
  assert.equal(alerts.length, 1);
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

test('ignores Tenda 32-bit offline sentinel 2097151 and strips non-LAN external IP glitches', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const mac = '3A:CB:5F:7D:4B:A7';

  acc.process(1_000_000, [device(mac, { sumKb: 500_000, online: 1 })], false);
  // Offline transition emitting INT32_MAX >> 10 = 2,097,151 KB and bogus external IP 17.57.156.25
  const rOffline = acc.process(1_010_000, [{
    ...device(mac, { sumKb: 2_097_151, online: 0 }),
    hostIP: '17.57.156.25',
  }], false);
  assert.equal(rOffline.totalBytesDownDelta, 0, '2097151 sentinel must not credit 1.6 GB phantom traffic');

  const rawRow = db.prepare(`SELECT ip, down_sum_kb FROM samples_raw WHERE mac = ? AND ts = 1010000`).get(mac) as any;
  assert.equal(rawRow.ip, '192.168.0.10', 'external IP glitch falls back to last known valid LAN IP instead of storing 17.57.156.25');
  assert.equal(rawRow.down_sum_kb, 500_000, 'offline sentinel preserves previous valid counter');

  // Fresh unknown host with bogus external IP and no prior LAN IP stores null
  acc.process(1_015_000, [{
    ...device('BB:CC:DD:EE:FF:00', { sumKb: 100, online: 1 }),
    hostIP: '108.159.102.127',
  }], false);
  const freshRow = db.prepare(`SELECT ip FROM samples_raw WHERE mac = 'BB:CC:DD:EE:FF:00'`).get() as any;
  assert.equal(freshRow.ip, null, 'non-LAN IPv4 with no prior valid LAN IP must be stored as null');

  // Reconnects with +100 KB real traffic
  const rBack = acc.process(1_020_000, [device(mac, { sumKb: 500_100, online: 1 })], false);
  assert.equal(rBack.totalBytesDownDelta, 100 * 1024);
});

test('strips local camera/repeater upload and bounds LAN camera hairpins to WAN flux ceiling', () => {
  const db = makeDb();
  const acc = new Accumulator(db);
  const studioMac = 'AA:11:22:33:44:55';
  const cameraMac = 'E0:CA:3C:67:03:A8'; // Hikvision OUI -> camera
  const repeaterMac = '66:62:8B:B3:9F:52'; // Hall repeater proxy MAC

  const wan = [
    { id: 1, upBps: 200 * 1024, downBps: 1_000_000 },
    { id: 2, upBps: 73 * 1024, downBps: 500_000 },
  ]; // total WAN upload = 273 KB/s = 279,552 B/s

  // Note: Tenda hostUploadSpeed is in integer KB/s
  acc.process(1_000_000, [
    device(studioMac, { sumKb: 1000, up: 552 }), // 273 KB/s WAN + 279 KB/s LAN Frigate stream
    device(cameraMac, { sumKb: 50, up: 400 }),   // Pure local RTSP camera
    device(repeaterMac, { sumKb: 5000, up: 300 }), // Hall repeater proxy
  ], false, wan);

  const r = acc.process(1_010_000, [
    device(studioMac, { sumKb: 1100, up: 552 }),
    device(cameraMac, { sumKb: 50, up: 400 }),
    device(repeaterMac, { sumKb: 5200, up: 300 }),
  ], false, wan);

  // Camera + repeater upload must be 0, and studioMac upload over 10s must be capped to WAN (273 * 1024 * 10 = 2,795,520)
  const expectedWanUpBytes = 273 * 1024 * 10;
  assert.equal(r.totalBytesUpDelta, expectedWanUpBytes);
  const camRow = db.prepare(`SELECT bytes_up FROM traffic_5min WHERE mac = ?`).get(cameraMac) as any;
  const repRow = db.prepare(`SELECT bytes_up FROM traffic_5min WHERE mac = ?`).get(repeaterMac) as any;
  const stuRow = db.prepare(`SELECT bytes_up FROM traffic_5min WHERE mac = ?`).get(studioMac) as any;
  assert.equal(camRow.bytes_up, 0);
  assert.equal(repRow.bytes_up, 0);
  assert.equal(stuRow.bytes_up, expectedWanUpBytes);
});

test('RollupWorker.rollupDay replaces day rows idempotently without DST duplicate buckets', () => {
  const db = makeDb();
  db.exec(`
    CREATE TABLE traffic_hour (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0, active_sec INTEGER DEFAULT 0, peak_down_bps INTEGER, peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts));
    CREATE TABLE traffic_day (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0, active_sec INTEGER DEFAULT 0, peak_down_bps INTEGER, peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts));
  `);

  const summerNoon = new Date(2026, 6, 15, 12, 0, 0, 0).getTime(); // July 15
  const winterNow = new Date(2026, 10, 15, 12, 0, 0, 0).getTime(); // Nov 15
  const trueSummerMidnight = new Date(2026, 6, 15, 0, 0, 0, 0).getTime();
  assert.equal(bucketDay(summerNoon), trueSummerMidnight);

  // Simulate a stale shifted row (+1h) left from old DST-broken logic alongside true hour row
  db.prepare(`INSERT INTO traffic_day (mac, bucket_ts, bytes_down, bytes_up, active_sec) VALUES (?, ?, 999999, 111111, 60)`)
    .run('AA:00:00:00:00:01', trueSummerMidnight + 3_600_000);
  db.prepare(`INSERT INTO traffic_hour (mac, bucket_ts, bytes_down, bytes_up, active_sec) VALUES (?, ?, 500000, 50000, 120)`)
    .run('AA:00:00:00:00:01', summerNoon);

  const worker = new RollupWorker(db);
  worker.rollupDay(winterNow);

  const rows = db.prepare(`SELECT bucket_ts, bytes_down, bytes_up FROM traffic_day WHERE mac = 'AA:00:00:00:00:01'`).all() as any[];
  assert.equal(rows.length, 1, 'stale +1h DST duplicate bucket must be purged on rollupDay');
  assert.equal(rows[0].bucket_ts, trueSummerMidnight);
  assert.equal(rows[0].bytes_down, 500000);
  assert.equal(rows[0].bytes_up, 50000);
});
