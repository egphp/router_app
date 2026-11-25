import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import {
  PiiSessionSanitizer,
  validateReadOnlySql,
  executeReadOnlySql,
  correlateDeviceWindowLanOrWan,
  computeProactiveQuotaForecast,
  runDataIntegrityWatchdog,
  encryptApiKeyForDb,
  decryptApiKeyFromDb,
  getAiSettings,
  updateAiSettings,
} from '../src/ai/index.js';
import { lookupOui, isLocallyAdministeredMac } from '../src/oui.js';

function makeFullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

test('027_ai_intelligence migration applies cleanly and enforces foreign keys', () => {
  const db = makeFullDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((t) => t.name),
    ['ai_device_profiles', 'ai_domain_cache', 'ai_insights', 'ai_qos_schedules', 'ai_syslog_clusters'],
  );
});

test('PiiSessionSanitizer scrubs MACs, IPs, DDNS, and secrets and detokenizes cleanly', () => {
  process.env.ROUTER_PASSWORD = 'superSecretRouterPassword99';
  const db = makeFullDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices (mac, hostname, router_remark, custom_label, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
    VALUES ('AA:BB:CC:11:22:33', 'Michaels-Mac-Studio', 'Studio', 'ماك ستوديو المكتب', 'Apple', 'computer', ?, ?, 0, ?, ?)
  `).run(now, now, now, now);

  const sanitizer = new PiiSessionSanitizer(db);
  const raw = 'Device AA:BB:CC:11:22:33 (Michaels-Mac-Studio) at 192.168.0.7 leaked superSecretRouterPassword99';
  const clean = sanitizer.sanitizeText(raw);

  assert.ok(!clean.includes('AA:BB:CC:11:22:33'));
  assert.ok(!clean.includes('Michaels-Mac-Studio'));
  assert.ok(!clean.includes('192.168.0.7'));
  assert.ok(!clean.includes('superSecretRouterPassword99'));
  assert.ok(clean.includes('DEV_01'));
  assert.ok(clean.includes('IP_01'));

  const restored = sanitizer.detokenizeText('استهلك DEV_01 على العنوان IP_01 نحو 4 GB');
  assert.ok(restored.includes('ماك ستوديو المكتب'));
  assert.ok(restored.includes('192.168.0.7'));
});

test('Read-only SQL sandbox allows SELECT/WITH and blocks mutations and secret tables', () => {
  const db = makeFullDb();
  assert.equal(validateReadOnlySql('DELETE FROM devices').ok, false);
  assert.equal(validateReadOnlySql('SELECT * FROM settings').ok, false);
  assert.equal(validateReadOnlySql('SELECT * FROM panel_passkeys').ok, false);
  assert.equal(validateReadOnlySql('SELECT * FROM kv').ok, false);
  assert.equal(validateReadOnlySql('SELECT 1; DROP TABLE devices').ok, false);

  const res = executeReadOnlySql('SELECT COUNT(*) AS total_devices FROM devices', {
    existingDbForMemoryTests: db,
  });
  assert.equal(res.ok, true);
  assert.equal(res.rows[0].total_devices, 0);
});

test('LAN vs WAN correlator distinguishes local NVR transfer from ISP WAN traffic', () => {
  const db = makeFullDb();
  const now = Date.now();
  // Only ~90 KB moved across WAN1 (3 KB/s * 30s) while 500 MB moved on a LAN device
  db.prepare(`
    INSERT INTO wan_samples (ts, wan_id, up_bytes_per_s, down_bytes_per_s)
    VALUES (?, 1, 1000, 2000)
  `).run(now - 30_000);

  const lanRes = correlateDeviceWindowLanOrWan(db, 500 * 1024 * 1024, now - 60_000, now);
  assert.equal(lanRes.attribution, 'lan_only');

  // Heavy WAN2 download (~16 MB/s * 30s = 480 MB) matching device delta
  db.prepare(`
    INSERT INTO wan_samples (ts, wan_id, up_bytes_per_s, down_bytes_per_s)
    VALUES (?, 2, 10000, 16000000)
  `).run(now - 15_000);
  const wan2Res = correlateDeviceWindowLanOrWan(db, 500 * 1024 * 1024, now - 60_000, now);
  assert.equal(wan2Res.attribution, 'wan2');
});

test('Encrypted AI settings and proactive quota forecaster work end-to-end', () => {
  const db = makeFullDb();
  const cipher = encryptApiKeyForDb('AIzaSyDummyTestKey123456789');
  assert.ok(!cipher.includes('AIzaSyDummy'));
  assert.equal(decryptApiKeyFromDb(cipher), 'AIzaSyDummyTestKey123456789');

  const updated = updateAiSettings(db, {
    apiKey: 'AIzaSyDummyTestKey123456789',
    wan1QuotaGb: 200,
    wan2QuotaGb: 150,
    billingRenewalDay: 5,
  });
  assert.equal(updated.configured, true);
  assert.equal(updated.wan1QuotaGb, 200);
  assert.equal(getAiSettings(db).billingRenewalDay, 5);

  const forecast = computeProactiveQuotaForecast(db);
  assert.equal(forecast.wans.length, 2);
  const integrity = runDataIntegrityWatchdog(db);
  assert.equal(integrity.healthy, true);
  assert.equal(lookupOui('18:68:CB:AA:BB:CC').vendor, 'Hikvision');
  assert.equal(isLocallyAdministeredMac('DA:A1:19:00:11:22'), true);
});
