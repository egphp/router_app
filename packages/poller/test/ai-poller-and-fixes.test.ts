import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { bucketDay, bucketHour, bucketMonth, runMigrations } from '@tenda/shared';
import { Accumulator } from '../src/accumulator.js';
import { EnrichmentWorker } from '../src/enrichment.js';
import { NsfwScanner } from '../src/nsfw-scanner.js';
import { rebuildTrafficFromSamples } from '../src/traffic-rebuilder.js';
import { QosScheduleRunner, isTimeInScheduleWindow } from '../src/qos-scheduler.js';
import { SecurityScanner } from '../src/security.js';

function makeFullMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

test('Bug Fix #1: NsfwScanner scans UDP router_log, nsfw_extra_domains, and ai_domain_cache', () => {
  const db = makeFullMemoryDb();
  const now = Date.now();
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      priority INTEGER,
      facility INTEGER,
      severity INTEGER,
      host TEXT,
      tag TEXT,
      message TEXT NOT NULL,
      src_ip TEXT NOT NULL
    );
  `);

  db.prepare(`INSERT INTO settings (key, value) VALUES ('nsfw_extra_domains', 'badcustom.org, example-adult.net')`).run();
  db.prepare(`
    INSERT INTO ai_domain_cache (domain, category, confidence, source, checked_at)
    VALUES ('zeroday-bad.xyz', 'adult', 0.94, 'gemini-decision-1', ?)
  `).run(now);

  const scanner = new NsfwScanner(db);
  db.prepare(`
    INSERT INTO router_log (ts, message, src_ip)
    VALUES (?, 'DNS query https://sub.badcustom.org/path from client 192.168.0.44 AA:BB:CC:DD:EE:11', '192.168.0.1')
  `).run(now + 100);
  db.prepare(`
    INSERT INTO router_log (ts, message, src_ip)
    VALUES (?, 'DNS query zeroday-bad.xyz from 192.168.0.44 AA:BB:CC:DD:EE:11', '192.168.0.1')
  `).run(now + 200);

  const res = scanner.scan(now + 500);
  assert.equal(res.hits, 2);
  assert.equal(res.pushCandidates.length, 2);
  assert.equal(res.pushCandidates[0]!.mac, 'AA:BB:CC:DD:EE:11');
});

test('Bug Fix #2: Accumulator upgrades Unknown vendor/category and EnrichmentWorker builds AI profiles & syslog clusters', async () => {
  const db = makeFullMemoryDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices (mac, router_id, hostname, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
    VALUES ('18:68:CB:11:22:33', 1, '', 'Unknown', 'unknown', ?, ?, 0, ?, ?)
  `).run(now - 60_000, now - 60_000, now - 60_000, now - 60_000);

  const acc = new Accumulator(db);
  acc.process(
    now,
    [
      {
        ID: 1,
        hostMAC: '18:68:CB:11:22:33',
        hostIP: '192.168.0.88',
        hostName: 'hik_cam_front',
        hostRemark: '',
        hostOnlineStatus: 1,
        hostDownloadSum: 100,
      } as any,
    ],
    false,
  );

  const dev = db.prepare(`SELECT vendor, category, hostname FROM devices WHERE mac = '18:68:CB:11:22:33'`).get() as any;
  assert.equal(dev.vendor, 'Hikvision');
  assert.equal(dev.category, 'camera');
  assert.equal(dev.hostname, 'hik_cam_front');

  db.prepare(`
    INSERT INTO router_syslog (router_id, ts, log_type, message, fetched_at)
    VALUES (10, ?, 1, 'detect 120 ARP attack from 192.168.0.88/18:68:CB:11:22:33', ?),
           (11, ?, 1, 'detect 95 ARP attack from 192.168.0.99/18:68:CB:11:22:44', ?)
  `).run(now - 1000, now, now - 500, now);

  const worker = new EnrichmentWorker(db);
  await worker.tick(now);
  const clusters = await worker.clusterSyslogTick(now);
  assert.ok(clusters >= 1);

  const profile = db.prepare(`SELECT * FROM ai_device_profiles WHERE mac = '18:68:CB:11:22:33'`).get() as any;
  assert.ok(profile);
  assert.equal(profile.inferred_category, 'camera');

  const clusterRow = db.prepare(`SELECT line_count, summary_ar FROM ai_syslog_clusters LIMIT 1`).get() as any;
  assert.equal(clusterRow.line_count, 2);
  assert.ok(clusterRow.summary_ar.includes('ARP'));
});

test('Bug Fix #3: Windowed rebuildTrafficFromSamples preserves >48h traffic_day/month history and boundary-day early hours', () => {
  const db = makeFullMemoryDb();
  const mac = 'AA:BB:CC:00:00:99';
  const now = new Date(2026, 5, 20, 18, 0, 0).getTime();
  const prevMonthTs = bucketMonth(new Date(2026, 4, 1, 0, 0, 0).getTime());
  const oldDayTs = bucketDay(new Date(2026, 5, 5, 0, 0, 0).getTime());
  const boundaryDayStart = bucketDay(new Date(2026, 5, 18, 0, 0, 0).getTime());
  const earlyBoundaryHour = bucketHour(boundaryDayStart + 2 * 3600_000); // 02:00 (pruned from samples_raw)
  const rawStartTs = boundaryDayStart + 14 * 3600_000; // 14:00 (still in samples_raw)

  db.prepare(`INSERT INTO traffic_month (mac, bucket_ts, bytes_down, bytes_up, active_sec) VALUES (?, ?, 900000000, 10000000, 3600)`).run(mac, prevMonthTs);
  db.prepare(`INSERT INTO traffic_day (mac, bucket_ts, bytes_down, bytes_up, active_sec) VALUES (?, ?, 50000000, 5000000, 1200)`).run(mac, oldDayTs);
  db.prepare(`INSERT INTO traffic_hour (mac, bucket_ts, bytes_down, bytes_up, active_sec) VALUES (?, ?, 20000000, 1000000, 600)`).run(mac, earlyBoundaryHour);

  // Raw samples starting at 14:00 on June 18 adding 100 KB (= 102,400 bytes)
  db.prepare(`
    INSERT INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, sessions, online_seconds)
    VALUES (?, ?, '192.168.0.20', 1, 0, 2048, 1000, 1, 60),
           (?, ?, '192.168.0.20', 1, 0, 2048, 1100, 1, 90)
  `).run(mac, rawStartTs, mac, rawStartTs + 30_000);

  const res = rebuildTrafficFromSamples(db, { now }); // replaceAll defaults to false!
  assert.equal(res.rawSamples, 2);

  const keptMonth = db.prepare(`SELECT bytes_down FROM traffic_month WHERE mac = ? AND bucket_ts = ?`).get(mac, prevMonthTs) as any;
  assert.equal(keptMonth.bytes_down, 900_000_000);

  const keptOldDay = db.prepare(`SELECT bytes_down FROM traffic_day WHERE mac = ? AND bucket_ts = ?`).get(mac, oldDayTs) as any;
  assert.equal(keptOldDay.bytes_down, 50_000_000);

  // Boundary day (June 18) must equal preserved 02:00 hour (20,000,000) + rebuilt 14:00 hour (102,400)!
  const boundaryDay = db.prepare(`SELECT bytes_down FROM traffic_day WHERE mac = ? AND bucket_ts = ?`).get(mac, boundaryDayStart) as any;
  assert.equal(boundaryDay.bytes_down, 20_000_000 + 100 * 1024);
});

test('Subsystem 9 & 4: QosScheduleRunner applies/reverts cleanly and SecurityScanner distinguishes LAN camera from WAN camera upload', async () => {
  const db = makeFullMemoryDb();
  const now = new Date(2026, 5, 16, 17, 30, 0).getTime(); // Tuesday 17:30
  assert.equal(isTimeInScheduleWindow(new Date(now), '0,1,2,3,4,5,6', '16:00', '20:00'), true);
  assert.equal(isTimeInScheduleWindow(new Date(now), '0,1,2,3,4,5,6', '22:00', '06:00'), false);

  const mac = 'AA:BB:CC:44:55:66';
  db.prepare(`
    INSERT INTO devices (mac, hostname, category, first_seen, last_seen, is_new, created_at, updated_at)
    VALUES (?, 'LivingRoomTV', 'tv', ?, ?, 0, ?, ?)
  `).run(mac, now, now, now, now);
  db.prepare(`
    INSERT INTO router_qos_limits (mac, router_id, ip, online, download_limit_kbs, upload_limit_kbs, updated_at)
    VALUES (?, 3, '192.168.0.50', 1, 0, 0, ?)
  `).run(mac, now);
  db.prepare(`
    INSERT INTO ai_qos_schedules (name, days_mask, start_hhmm, end_hhmm, target_selector_json, download_limit_kbs, upload_limit_kbs, wan_port, enabled, created_at, updated_at)
    VALUES ('Study Time TV Cap', '0,1,2,3,4,5,6', '16:00', '20:00', ?, 512, 128, 2, 1, ?, ?)
  `).run(JSON.stringify({ categories: ['tv'] }), now, now);

  const calls: any[] = [];
  const fakeRouter = {
    async setDeviceSpeedLimit(arg: any) {
      calls.push({ type: 'qos', ...arg });
      return { ok: true, applied: { routerId: 3, mac: arg.mac, downloadLimitKBs: arg.downloadLimitKBs, uploadLimitKBs: arg.uploadLimitKBs, remark: '' } };
    },
    async setDeviceWanBinding(arg: any) {
      calls.push({ type: 'wan', ...arg });
      return { ok: true, applied: { ip: arg.ip, wanPort: arg.wanPort, ruleId: 1, ipGroupId: 1, ipGroupName: 'tv' } };
    },
  };

  const runner = new QosScheduleRunner(db, fakeRouter as any);
  const t1 = await runner.tick(now);
  assert.equal(t1.applied, 1);
  assert.equal(calls.some((c) => c.type === 'qos' && c.downloadLimitKBs === 512), true);

  // Move outside window -> 21:00 -> must revert back to 0 KB/s!
  const afterWindow = new Date(2026, 5, 16, 21, 0, 0).getTime();
  const t2 = await runner.tick(afterWindow);
  assert.equal(t2.reverted, 1);
  assert.equal(calls[calls.length - 1].downloadLimitKBs, 0);

  // Role-aware camera check: 3 MB/s upload with near-zero WAN = LAN Frigate NVR -> 0 alerts!
  const sec = new SecurityScanner(db);
  db.prepare(`INSERT INTO wan_samples (ts, wan_id, up_bytes_per_s, down_bytes_per_s) VALUES (?, 1, 500, 500)`).run(now - 10_000);
  const lanCamChecks = sec.scan(now, [
    {
      ID: 9,
      hostMAC: '18:68:CB:AA:BB:CC',
      hostIP: '192.168.0.201',
      hostName: 'hik_cam',
      hostOnlineStatus: 1,
      hostUploadSpeed: 3072, // 3 MB/s
    } as any,
  ]);
  assert.equal(lanCamChecks.filter((c) => c.rule.includes('upload')).length, 0);
});
