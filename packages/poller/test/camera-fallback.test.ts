import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isAic8800FallbackMac } from '@tenda/shared';
import { Accumulator } from '../src/accumulator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
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
    CREATE TABLE traffic_hour (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0, active_sec INTEGER DEFAULT 0, peak_down_bps INTEGER, peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts));
    CREATE TABLE traffic_day (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0, active_sec INTEGER DEFAULT 0, peak_down_bps INTEGER, peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts));
    CREATE TABLE traffic_month (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0, active_sec INTEGER DEFAULT 0, peak_down_bps INTEGER, peak_up_bps INTEGER,
      PRIMARY KEY (mac, bucket_ts));
    CREATE TABLE device_sessions (mac TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
      bytes_down INTEGER DEFAULT 0, bytes_up INTEGER DEFAULT 0,
      down_counter_base_kb INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mac, started_at));
    CREATE TABLE dhcp_reservations (mac TEXT PRIMARY KEY, ip TEXT NOT NULL, hostname TEXT, router_id INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, mac TEXT, payload TEXT,
      created_at INTEGER, dismissed_at INTEGER);
    CREATE TABLE notification_state (state_key TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
  `);
  return db;
}

function routerDev(mac: string, ip: string, opts: { sumKb?: number; up?: number; down?: number; online?: 0 | 1; name?: string } = {}) {
  return {
    ID: 100,
    hostIP: ip,
    hostMAC: mac,
    hostName: opts.name ?? '',
    hostRemark: '',
    hostUploadSpeed: opts.up ?? 0,
    hostDownloadSpeed: opts.down ?? 0,
    hostConnectCount: 1,
    hostDownloadSum: opts.sumKb ?? 0,
    hostConnectType: 3,
    hostUploadLimit: 64,
    hostDownloadLimit: 512,
    onlineTime: 1,
    hostAuthType: '',
    authUserName: '',
    hostOnlineStatus: (opts.online ?? 1) as any,
  };
}

test('isAic8800FallbackMac matches only 88:00:33:77:XX:XX boot-fallback MACs', () => {
  assert.equal(isAic8800FallbackMac('88:00:33:77:AC:92'), true);
  assert.equal(isAic8800FallbackMac('88:00:33:77:64:35'), true);
  assert.equal(isAic8800FallbackMac('50:0F:F5:B2:F2:D0'), false);
  assert.equal(isAic8800FallbackMac('88:00:33:78:AC:92'), false);
  assert.equal(isAic8800FallbackMac('DE:AD:BE:EF:00:32'), false);
});

test('suppresses AIC8800 88:00:33:77:* camera boot-fallback alerts & phantom rows while crediting traffic to canonical camera', () => {
  const db = makeDb();
  const acc = new Accumulator(db);

  // Real Tenda CP3 camera already known on 192.168.0.32
  const r0 = acc.process(1_000_000, [
    routerDev('50:0F:F5:B2:F2:D0', '192.168.0.32', { sumKb: 1000, name: 'IPC', online: 1 }),
  ], false);
  assert.deepEqual(r0.newDevices, ['50:0F:F5:B2:F2:D0']);
  db.exec(`DELETE FROM alerts;`);

  // Camera reboots at 03:05 AM and associates briefly with AIC8800 fallback MAC 88:00:33:77:AC:92 on .32
  const r1 = acc.process(1_030_000, [
    routerDev('50:0F:F5:B2:F2:D0', '192.168.0.32', { sumKb: 1000, name: 'IPC', online: 0 }),
    routerDev('88:00:33:77:AC:92', '192.168.0.32', { sumKb: 50, up: 10, down: 20, name: '', online: 1 }),
  ], false);
  assert.deepEqual(r1.newDevices, [], 'must NOT emit newDevices for 88:00:33:77:* fallback MAC');

  // Next sample during fallback window transfers +200 KB download
  const r2 = acc.process(1_060_000, [
    routerDev('50:0F:F5:B2:F2:D0', '192.168.0.32', { sumKb: 1000, name: 'IPC', online: 0 }),
    routerDev('88:00:33:77:AC:92', '192.168.0.32', { sumKb: 250, up: 10, down: 20, name: '', online: 1 }),
  ], false);
  assert.deepEqual(r2.newDevices, []);
  assert.equal(r2.totalBytesDownDelta, 200 * 1024);

  const phantomDevice = db.prepare(`SELECT * FROM devices WHERE mac LIKE '88:00:33:77:%'`).all();
  assert.equal(phantomDevice.length, 0, 'phantom fallback MAC must not pollute devices table');

  const alerts = db.prepare(`SELECT * FROM alerts`).all();
  assert.equal(alerts.length, 0, 'must not insert new_device alert for fallback MAC');

  const canonicalBucket = db.prepare(`SELECT SUM(bytes_down) AS bd FROM traffic_5min WHERE mac = '50:0F:F5:B2:F2:D0'`).get() as { bd: number };
  assert.equal(canonicalBucket.bd, 200 * 1024, 'fallback traffic delta is preserved under canonical camera MAC');
});

test('ignores offline 88:00:33:77:* NVRAM ghosts returned by router getQosUserList', () => {
  const db = makeDb();
  const acc = new Accumulator(db);

  const r = acc.process(1_000_000, [
    routerDev('88:00:33:77:64:35', '192.168.0.94', { sumKb: 400, online: 0 }),
    routerDev('88:00:33:77:11:22', '192.168.0.81', { sumKb: 100, online: 0 }),
  ], false);

  assert.deepEqual(r.newDevices, []);
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM devices`).get() as any).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM samples_raw`).get() as any).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM alerts`).get() as any).c, 0);
});

test('still alerts on genuine non-88:00:33:77 unknown MAC even on a camera IP', () => {
  const db = makeDb();
  const acc = new Accumulator(db);

  acc.process(1_000_000, [
    routerDev('50:0F:F5:B2:F2:D0', '192.168.0.32', { sumKb: 1000, name: 'IPC', online: 1 }),
  ], false);
  db.exec(`DELETE FROM alerts;`);

  // Genuine unknown device spoofing or taking 192.168.0.32
  const r = acc.process(1_030_000, [
    routerDev('DE:AD:BE:EF:00:32', '192.168.0.32', { sumKb: 10, name: 'kali', online: 1 }),
  ], false);

  assert.deepEqual(r.newDevices, ['DE:AD:BE:EF:00:32']);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE kind = 'new_device'`).all();
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0] as any).mac, 'DE:AD:BE:EF:00:32');
});

test('021_aic8800_camera_cleanup.sql merges traffic into canonical camera and removes phantom rows', () => {
  const db = makeDb();
  const now = 1_700_000_000_000;

  db.exec(`
    INSERT INTO devices (mac, hostname, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
    VALUES
      ('50:0F:F5:B2:F2:D0', 'IPC', 'Unknown', 'unknown', ${now}, ${now}, 0, ${now}, ${now}),
      ('88:00:33:77:AC:92', '', 'Unknown', 'unknown', ${now}, ${now}, 1, ${now}, ${now}),
      ('88:00:33:77:BB:11', '', 'Unknown', 'unknown', ${now}, ${now}, 1, ${now}, ${now});

    INSERT INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb)
    VALUES
      ('50:0F:F5:B2:F2:D0', ${now}, '192.168.0.32', 0, 0, 0, 500),
      ('88:00:33:77:AC:92', ${now}, '192.168.0.32', 0, 0, 0, 200),
      ('88:00:33:77:BB:11', ${now + 1000}, '192.168.0.32', 0, 0, 0, 300);

    INSERT INTO traffic_day (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
    VALUES
      ('50:0F:F5:B2:F2:D0', 1000, 10000, 2000, 60, 500, 100),
      ('88:00:33:77:AC:92', 1000, 4000, 1000, 30, 800, 150),
      ('88:00:33:77:BB:11', 2000, 3000, 500, 20, 400, 90);

    INSERT INTO alerts (kind, mac, payload, created_at, dismissed_at)
    VALUES
      ('new_device', '88:00:33:77:AC:92', '{"ip":"192.168.0.32"}', ${now}, NULL),
      ('new_device', '88:00:33:77:BB:11', '{"ip":"192.168.0.32"}', ${now}, NULL);
  `);

  const sqlPath = path.resolve(__dirname, '../../shared/src/migrations/021_aic8800_camera_cleanup.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  db.exec(sql);

  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM devices WHERE mac LIKE '88:00:33:77:%'`).get() as any).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE mac LIKE '88:00:33:77:%'`).get() as any).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM samples_raw WHERE mac LIKE '88:00:33:77:%'`).get() as any).c, 0);

  const day1 = db.prepare(`SELECT bytes_down, bytes_up, peak_down_bps FROM traffic_day WHERE mac = '50:0F:F5:B2:F2:D0' AND bucket_ts = 1000`).get() as any;
  assert.equal(day1.bytes_down, 14000);
  assert.equal(day1.bytes_up, 3000);
  assert.equal(day1.peak_down_bps, 800);

  const day2 = db.prepare(`SELECT bytes_down, bytes_up FROM traffic_day WHERE mac = '50:0F:F5:B2:F2:D0' AND bucket_ts = 2000`).get() as any;
  assert.equal(day2.bytes_down, 3000);
  assert.equal(day2.bytes_up, 500);

  const cam = db.prepare(`SELECT vendor, category FROM devices WHERE mac = '50:0F:F5:B2:F2:D0'`).get() as any;
  assert.equal(cam.vendor, 'Tenda');
  assert.equal(cam.category, 'camera');
});
