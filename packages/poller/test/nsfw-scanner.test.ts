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

test('nsfw scanner ignores IPTV/HLS/VOD .xyz streaming CDNs and non-adult AI categories (malware_phishing/gambling)', () => {
  const db = makeDb();
  db.exec(`
    CREATE TABLE ai_domain_cache (
      domain TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason_ar TEXT,
      model TEXT,
      decided_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const now = Date.now() + 5000;
  // Seed cached AI classifications that previously caused false "Adult content access detected" banners
  db.prepare(`
    INSERT INTO ai_domain_cache (domain, category, confidence, reason_ar, model, decided_at, expires_at)
    VALUES
      ('bbcukjournal.xyz', 'malware_phishing', 0.78, 'Suspicious TLD', 'gemini-decision-1', ?, ?),
      ('testyourowncv.xyz', 'malware_phishing', 0.74, 'Suspicious TLD', 'gemini-decision-1', ?, ?),
      ('somecasino-test.com', 'gambling', 0.95, 'Casino', 'gemini-decision-1', ?, ?),
      ('lowconf-adult-test.com', 'adult', 0.81, 'Uncertain', 'gemini-decision-1', ?, ?),
      ('verified-adult-test.com', 'adult', 0.96, 'Explicit adult portal', 'gemini-decision-1', ?, ?)
  `).run(now, now + 86400000, now, now + 86400000, now, now + 86400000, now, now + 86400000, now, now + 86400000);

  const ins = db.prepare(`
    INSERT INTO router_syslog (router_id, ts, log_type, message, attacker_ip, attacker_mac, fetched_at)
    VALUES (?, ?, 6, ?, '192.168.0.7', '3A:CB:5F:7D:4B:A7', ?)
  `);
  ins.run(10, now + 1, 'http://1j50sc.a8k16.bbcukjournal.xyz:80/series/user/pass/764471.mkv?token=abc', now + 1);
  ins.run(11, now + 2, 'http://pcvdrd.a8s5.testyourowncv.xyz:8080/hls/live/stream.m3u8?token=xyz', now + 2);
  ins.run(12, now + 3, 'dns query somecasino-test.com', now + 3);
  ins.run(13, now + 4, 'dns query lowconf-adult-test.com', now + 4);
  ins.run(14, now + 5, 'dns query verified-adult-test.com', now + 5);

  const scanner = new NsfwScanner(db);
  const res = scanner.scan(now + 10);

  assert.equal(res.hits, 1, 'only verified high-confidence (>=0.92) adult domain may enter nsfw_hits');
  const rows = db.prepare(`SELECT domain, category FROM nsfw_hits`).all() as Array<{ domain: string; category: string }>;
  assert.deepEqual(rows, [{ domain: 'verified-adult-test.com', category: 'ai-adult' }]);
});
