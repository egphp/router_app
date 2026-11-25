import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DAY, HOUR, runMigrations } from '@tenda/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-mcp-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');

// Seed realistic router-only telemetry in isolated SQLite DB
{
  const db = new Database(dbPath);
  runMigrations(db);
  const now = Date.now();
  const hourBucket = Math.floor(now / HOUR) * HOUR - HOUR;

  db.prepare(
    `INSERT INTO devices (mac, hostname, custom_label, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
     VALUES ('AA:BB:CC:DD:EE:01', 'living-room-tv', 'شاشة الصالة', 'Samsung', 'tv', ?, ?, 0, ?, ?)`,
  ).run(now - 20 * DAY, now, now, now);

  db.prepare(
    `INSERT INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, wifi_band, wifi_rssi_dbm)
     VALUES ('AA:BB:CC:DD:EE:01', ?, '192.168.0.55', 1, 24000, 650000, 512000, '2.4GHz', -79)`,
  ).run(now - 5000);

  db.prepare(
    `INSERT INTO traffic_hour (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
     VALUES ('AA:BB:CC:DD:EE:01', ?, ?, ?, 1800, 900000, 45000)`,
  ).run(hourBucket, 850 * 1024 * 1024, 25 * 1024 * 1024);

  db.prepare(
    `INSERT INTO router_wan_ports (wan_id, wan_name, status, wan_type, up_flux_bps, down_flux_bps, updated_at)
     VALUES (1, 'WAN1', 'connected', 'pppoe', 30000, 620000, ?),
            (2, 'WAN2', 'connected', 'dhcp', 4000, 12000, ?)`,
  ).run(now, now);

  db.prepare(
    `INSERT INTO ai_device_profiles (mac, suggested_label, inferred_category, trust_tier, recommended_qos_profile, recommended_down_kbs, recommended_up_kbs, recommended_wan, rationale_ar, updated_at)
     VALUES ('AA:BB:CC:DD:EE:01', 'شاشة سامسونج', 'tv', 'iot_entertainment', 'hd_stream', 640, 256, 'WAN2', 'بث مرئي مرتفع الاستهلاك', ?)`,
  ).run(now);

  db.close();
}

let receivedControlPayload: Record<string, unknown> | null = null;
const mockPoller = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/device-control') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      receivedControlPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, qos: { downloadLimitKBs: receivedControlPayload?.downloadLimitKBs } }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>((resolve) => mockPoller.listen(0, '127.0.0.1', () => resolve()));
const pollerAddr = mockPoller.address();
const controlPort = typeof pollerAddr === 'object' && pollerAddr ? pollerAddr.port : 3031;

const useDist = process.env.MCP_USE_DIST === '1';
const tsxLoader = path.resolve(pkgRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const args = useDist
  ? [path.resolve(pkgRoot, 'dist', 'index.js')]
  : ['--conditions=dev-source', '--import', tsxLoader, path.resolve(pkgRoot, 'src', 'index.ts')];

const transport = new StdioClientTransport({
  command: process.execPath,
  args,
  cwd: pkgRoot,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    CONTROL_PORT: String(controlPort),
  },
});

const client = new Client({ name: 'tenda-mcp-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'tenda_diagnose_anomalies_and_outages',
    'tenda_get_device_detail',
    'tenda_get_network_overview',
    'tenda_get_quota_forecast',
    'tenda_list_devices',
    'tenda_query_readonly_sql',
    'tenda_set_device_control',
  ]);

  const overview = await client.callTool({
    name: 'tenda_get_network_overview',
    arguments: { response_format: 'json' },
  });
  assert.ok(!overview.isError, 'tenda_get_network_overview should succeed');

  const listed = await client.callTool({
    name: 'tenda_list_devices',
    arguments: { online_only: true, response_format: 'json' },
  });
  assert.ok(!listed.isError);
  const listedJson = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text);
  assert.equal(listedJson.total, 1);
  assert.equal(listedJson.devices[0].mac, 'AA:BB:CC:DD:EE:01');

  const detail = await client.callTool({
    name: 'tenda_get_device_detail',
    arguments: { device: 'شاشة الصالة', response_format: 'json' },
  });
  assert.ok(!detail.isError);

  const sqlOk = await client.callTool({
    name: 'tenda_query_readonly_sql',
    arguments: { sql: 'SELECT mac, custom_label FROM devices' },
  });
  assert.ok(!sqlOk.isError);

  const sqlBlocked = await client.callTool({
    name: 'tenda_query_readonly_sql',
    arguments: { sql: 'DROP TABLE devices' },
  });
  assert.equal(sqlBlocked.isError, true, 'Mutating SQL must be rejected');

  const secretBlocked = await client.callTool({
    name: 'tenda_query_readonly_sql',
    arguments: { sql: 'SELECT * FROM settings' },
  });
  assert.equal(secretBlocked.isError, true, 'Secrets table must be blocked');

  const diag = await client.callTool({
    name: 'tenda_diagnose_anomalies_and_outages',
    arguments: { lookback_hours: 24, response_format: 'markdown' },
  });
  assert.ok(!diag.isError);

  const forecast = await client.callTool({
    name: 'tenda_get_quota_forecast',
    arguments: { response_format: 'markdown' },
  });
  assert.ok(!forecast.isError);

  const ctrl = await client.callTool({
    name: 'tenda_set_device_control',
    arguments: {
      device: 'AA:BB:CC:DD:EE:01',
      download_limit_kbs: 640,
      upload_limit_kbs: 256,
      wan_port: 'WAN2',
    },
  });
  assert.ok(!ctrl.isError, 'tenda_set_device_control should succeed via mock poller');
  assert.equal(receivedControlPayload?.mac, 'AA:BB:CC:DD:EE:01');
  assert.equal(receivedControlPayload?.downloadLimitKBs, 640);
  assert.equal(receivedControlPayload?.wanPort, 'WAN2');

  console.log(`[smoke] PASS (${useDist ? 'dist' : 'dev-source'}): all 7 MCP tools verified end-to-end`);
} finally {
  await client.close().catch(() => {});
  mockPoller.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
