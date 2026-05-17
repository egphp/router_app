import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ThresholdAlertMonitor } from '../src/threshold-alerts.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE devices (
      mac TEXT PRIMARY KEY,
      hostname TEXT,
      router_remark TEXT,
      custom_label TEXT
    );
    CREATE TABLE traffic_5min (
      mac TEXT,
      bucket_ts INTEGER,
      bytes_down INTEGER DEFAULT 0,
      bytes_up INTEGER DEFAULT 0
    );
    CREATE TABLE traffic_hour (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0);
    CREATE TABLE traffic_day (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0);
    CREATE TABLE traffic_month (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER DEFAULT 0);
    CREATE TABLE device_sessions (mac TEXT, bytes_down INTEGER DEFAULT 0);
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT,
      mac TEXT,
      payload TEXT,
      created_at INTEGER,
      dismissed_at INTEGER
    );
    CREATE TABLE notification_suppressions (
      suppression_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      rule TEXT,
      mac TEXT,
      label TEXT,
      source_alert_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE notification_state (
      state_key TEXT PRIMARY KEY,
      last_triggered_at INTEGER NOT NULL,
      value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE device_notification_thresholds (
      mac TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      download_limit_bytes INTEGER NOT NULL DEFAULT 0,
      period TEXT NOT NULL DEFAULT 'today',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT,
      auth TEXT,
      expiration_time INTEGER,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_error TEXT,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      client_platform TEXT,
      client_user_agent TEXT
    );
    CREATE TABLE push_delivery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_hash TEXT,
      tag TEXT,
      status TEXT,
      error TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

function insertDeviceUsage(db: Database.Database, mac: string, label: string, bytesDown: number, now: number): void {
  db.prepare(`INSERT INTO devices (mac, hostname) VALUES (?, ?)`).run(mac, label);
  db.prepare(`INSERT INTO traffic_5min (mac, bucket_ts, bytes_down) VALUES (?, ?, ?)`)
    .run(mac, Math.floor(now / 300_000) * 300_000, bytesDown);
}

test('explicit device threshold fires even when default per-device threshold is off', async () => {
  const db = makeDb();
  const now = Date.now();
  const mac = 'AA:BB:CC:DD:EE:01';
  insertDeviceUsage(db, mac, 'Threshold Phone', 2048, now);
  setSetting(db, 'notification_total_download_enabled', 'off');
  setSetting(db, 'notification_device_download_enabled', 'off');
  setSetting(db, 'notification_device_download_default_limit_bytes', '0');
  setSetting(db, 'notification_device_download_default_period', 'today');
  db.prepare(`
    INSERT INTO device_notification_thresholds
      (mac, enabled, download_limit_bytes, period, created_at, updated_at)
    VALUES (?, 1, 1000, 'today', ?, ?)
  `).run(mac, now, now);

  await new ThresholdAlertMonitor(db).scan(now);
  await new ThresholdAlertMonitor(db).scan(now + 1);

  const alerts = db.prepare(`SELECT kind, mac, payload FROM alerts`).all() as Array<{ kind: string; mac: string; payload: string }>;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'device_download_threshold');
  assert.equal(alerts[0].mac, mac);
  assert.match(alerts[0].payload, /Threshold Phone/);
});

test('total and default per-device thresholds create one alert each and dedupe per bucket', async () => {
  const db = makeDb();
  const now = Date.now();
  const mac = 'AA:BB:CC:DD:EE:02';
  insertDeviceUsage(db, mac, 'Default Limit Device', 4096, now);
  setSetting(db, 'notification_total_download_enabled', 'on');
  setSetting(db, 'notification_total_download_limit_bytes', '1000');
  setSetting(db, 'notification_total_download_period', 'today');
  setSetting(db, 'notification_device_download_enabled', 'on');
  setSetting(db, 'notification_device_download_default_limit_bytes', '1000');
  setSetting(db, 'notification_device_download_default_period', 'today');

  await new ThresholdAlertMonitor(db).scan(now);
  await new ThresholdAlertMonitor(db).scan(now + 1);

  const rows = db.prepare(`SELECT kind, COUNT(*) AS count FROM alerts GROUP BY kind ORDER BY kind`).all() as Array<{ kind: string; count: number }>;
  assert.deepEqual(rows, [
    { kind: 'device_download_threshold', count: 1 },
    { kind: 'total_download_threshold', count: 1 },
  ]);
});
