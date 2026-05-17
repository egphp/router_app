import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { NsfwScanner } from '../src/nsfw-scanner.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE router_syslog (
      router_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      log_type INTEGER NOT NULL,
      message TEXT NOT NULL,
      attacker_ip TEXT,
      attacker_mac TEXT,
      attack_kind TEXT,
      attack_count INTEGER,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (router_id, ts)
    );
    CREATE TABLE nsfw_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source_mac TEXT,
      source_ip TEXT,
      domain TEXT NOT NULL,
      category TEXT NOT NULL,
      raw_excerpt TEXT
    );
    CREATE TABLE nsfw_push_events (
      event_key TEXT PRIMARY KEY,
      source_mac TEXT,
      source_ip TEXT,
      domain TEXT NOT NULL,
      category TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

test('nsfw scanner stores hits and creates one push candidate per device/domain/hour', () => {
  const db = makeDb();
  const scanner = new NsfwScanner(db);
  const ts = Date.now() + 1000;
  db.prepare(`
    INSERT INTO router_syslog (router_id, ts, log_type, message, attacker_ip, attacker_mac, fetched_at)
    VALUES (?, ?, 6, ?, ?, ?, ?)
  `).run(
    1,
    ts,
    'dns query pornhub.com from client',
    '192.168.0.55',
    'aa:bb:cc:dd:ee:ff',
    ts,
  );
  db.prepare(`
    INSERT INTO router_syslog (router_id, ts, log_type, message, attacker_ip, attacker_mac, fetched_at)
    VALUES (?, ?, 6, ?, ?, ?, ?)
  `).run(
    2,
    ts + 1,
    'dns query pornhub.com again',
    '192.168.0.55',
    'aa:bb:cc:dd:ee:ff',
    ts + 1,
  );

  const result = scanner.scan(ts + 10);
  assert.equal(result.hits, 2);
  assert.equal(result.pushCandidates.length, 1);
  assert.equal(result.pushCandidates[0].mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(result.pushCandidates[0].ip, '192.168.0.55');
  assert.equal(result.pushCandidates[0].domain, 'pornhub.com');

  const events = db.prepare(`SELECT COUNT(*) AS count FROM nsfw_push_events`).get() as { count: number };
  assert.equal(events.count, 1);
});
