import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// Allow importing Next.js `server-only` modules inside Node's native test runner
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {};', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Isolate SQLite & session secret BEFORE importing web modules so production tenda.db is untouched.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-web-control-'));
process.env.DB_PATH = path.join(tmpDir, 'test-control.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
const sharedKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const sharedCredId = crypto.randomBytes(16).toString('base64url');
const sharedPasskeyPath = path.join(tmpDir, 'owner-passkey.json');
fs.writeFileSync(
  sharedPasskeyPath,
  JSON.stringify({
    credentialId: sharedCredId,
    publicKeyPem: sharedKeyPair.publicKey.export({ type: 'spki', format: 'pem' }),
    rpId: 'tv-eg.com',
  }),
  { mode: 0o600 },
);
process.env.TENDA_SHARED_PASSKEY_FILE = sharedPasskeyPath;

// Stand up a local mock Poller Control Server on an ephemeral port BEFORE importing route handlers
let mockControlPort = 0;
let lastControlPayload: Record<string, unknown> | null = null;
let lastAutoQosPayload: Record<string, unknown> | null = null;
let lastSshAccessPayload: Record<string, unknown> | null = null;
let refreshPublicIpsCount = 0;
let mockServer: http.Server;

const serverReady = new Promise<void>((resolve) => {
  mockServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/device-control') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/wan-public-ip/refresh') {
      refreshPublicIpsCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, publicIps: { 1: '156.196.235.143', 2: '156.196.19.204' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/ssh-access') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastSshAccessPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const db = getDb();
        const now = Date.now();
        const enabled = Boolean(lastSshAccessPayload?.enabled);
        const targetIp = String(lastSshAccessPayload?.targetIp ?? '192.168.0.7');
        const extPort = Number(lastSshAccessPayload?.externalPort ?? 22222);
        const sshUser = String(lastSshAccessPayload?.sshUser ?? 'michaeltawfik');
        db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run('router.ssh_access.enabled', enabled ? '1' : '0');
        db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run('router.ssh_access.target_ip', targetIp);
        db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run('router.ssh_access.external_port', String(extPort));
        db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run('router.ssh_access.ssh_user', sshUser);
        db.prepare(`DELETE FROM router_port_mappings`).run();
        if (enabled) {
          db.prepare(`
            INSERT INTO router_port_mappings (id, wan_id, server_ip, internal_port, external_port, protocol, enabled, updated_at)
            VALUES (1, 1, ?, 22, ?, 1, 1, ?), (2, 2, ?, 22, ?, 1, 1, ?)
          `).run(targetIp, extPort, now, targetIp, extPort, now);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sshAccess: { enabled, targetIp, externalPort: extPort, sshUser } }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/auto-qos-policy') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastAutoQosPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoQos: lastAutoQosPayload }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/device-control') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastControlPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            qos: lastControlPayload?.downloadLimitKBs !== undefined
              ? {
                  downloadLimitKBs: lastControlPayload.downloadLimitKBs,
                  uploadLimitKBs: lastControlPayload.uploadLimitKBs,
                }
              : null,
            wan: lastControlPayload?.wanPort !== undefined
              ? { wanPort: lastControlPayload.wanPort, ipGroupName: lastControlPayload.wanGroupName ?? null }
              : null,
            dhcp: lastControlPayload?.dhcpReserved !== undefined
              ? { reserved: Boolean(lastControlPayload.dhcpReserved), ip: lastControlPayload.ip ?? null }
              : null,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  mockServer.listen(0, '127.0.0.1', () => {
    const addr = mockServer.address();
    mockControlPort = typeof addr === 'object' && addr ? addr.port : 0;
    process.env.CONTROL_PORT = String(mockControlPort);
    resolve();
  });
});

await serverReady;

const { closeDb, getDb, runMigrations } = await import('@tenda/shared');
const { PANEL_COOKIE, createPanelSessionCookie } = await import('../lib/remote-auth');
const { getDevice, getLatestDevices, getNetworkControlSummary } = await import('../lib/queries');
const { mergeRouterLiveDevices } = await import('../lib/router-live');
const { formatSpeedLimitKbs, formatDevicePolicyBadge, kbsToMbps, mbpsToKbs } = await import('../lib/control-format');
const { POST: postDeviceControl } = await import('../app/api/devices/[mac]/control/route');
const { GET: getNetworkControlRoute, POST: postNetworkControlRoute } = await import('../app/api/network-control/route');

before(() => {
  const db = getDb();
  runMigrations(db);
  const now = Date.now();

  db.prepare(`
    INSERT INTO devices (mac, hostname, router_remark, custom_label, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
    VALUES
      ('AA:BB:CC:DD:EE:01', 'PlayStation-5', 'playstation', 'بلايستيشن الصالة', 'Sony', 'game_console', ?, ?, 0, ?, ?),
      ('50:0F:F5:B2:F2:D0', 'IPC', 'camera_gate', 'كاميرا البوابة', 'Tenda', 'camera', ?, ?, 0, ?, ?),
      ('AA:BB:CC:DD:EE:99', 'New-Guest', null, null, null, 'phone', ?, ?, 1, ?, ?)
  `).run(now, now, now, now, now, now, now, now, now, now, now, now);

  db.prepare(`
    INSERT INTO samples_raw (ts, mac, ip, online, up_speed_bps, down_speed_bps, down_sum_kb)
    VALUES
      (?, 'AA:BB:CC:DD:EE:01', '192.168.0.167', 1, 2048, 51200, 1024),
      (?, '50:0F:F5:B2:F2:D0', '192.168.0.32', 1, 16384, 1024, 512)
  `).run(now, now);

  db.prepare(`
    INSERT INTO router_qos_limits (mac, router_id, ip, router_remark, online, download_limit_kbs, upload_limit_kbs, updated_at)
    VALUES
      ('AA:BB:CC:DD:EE:01', 7, '192.168.0.167', 'playstation', 1, 625, 64, ?),
      ('AA:BB:CC:DD:EE:99', 8, null, null, 1, 256, 64, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO device_auto_qos (mac, state, target_down_kbs, target_up_kbs, attempts, applied_at, created_at, updated_at)
    VALUES ('AA:BB:CC:DD:EE:99', 'applied', 256, 64, 1, ?, ?, ?)
  `).run(now, now, now);

  db.prepare(`
    INSERT INTO router_wan_ports (
      wan_id, wan_name, status, wan_type, wan_ip, wan_gateway, up_flux_bps, down_flux_bps,
      public_ip, public_ip_checked_at, public_ip_changed_at,
      ddns_fqdn, ddns_synced_ip, ddns_synced_at, ddns_last_error,
      updated_at
    )
    VALUES
      (1, 'WAN1', 'wired', 'dhcp', '192.168.3.13', '192.168.3.1', 12000, 350000, '156.196.235.143', ?, ?, 'w1-testslug.example.net', '156.196.235.143', ?, NULL, ?),
      (2, 'WAN2', 'wired', 'dhcp', '192.168.2.17', '192.168.2.1', 8000, 190000, '156.196.19.204', ?, ?, 'w2-testslug.example.net', '156.196.19.204', ?, NULL, ?)
  `).run(now, now, now, now, now, now, now, now);

  db.prepare(`
    INSERT INTO router_wan_bindings (ip, wan_port, rule_id, rule_enabled, ip_group_id, ip_group_name, start_ip, end_ip, inherited_from_range, updated_at)
    VALUES ('192.168.0.167', 'WAN2', 5, 1, 5, 'playstation', '192.168.0.167', '192.168.0.167', 0, ?)
  `).run(now);

  db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('router.qos_policy', '2'), ('router.wan_route_policy', 'custom')`).run();
});

after(async () => {
  closeDb();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAuthedRequest(url: string, method = 'GET', body?: unknown): Request {
  const origin = 'https://tv-eg.com:2055';
  const seedReq = new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { host: 'tv-eg.com:2055', 'x-forwarded-proto': 'https', origin },
  });
  const token = createPanelSessionCookie({
    credentialId: sharedCredId,
    rpId: 'tv-eg.com',
    req: seedReq,
  });
  const headers = new Headers({
    host: 'tv-eg.com:2055',
    'x-forwarded-proto': 'https',
    origin,
    cookie: `${PANEL_COOKIE}=${encodeURIComponent(token)}`,
  });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${origin}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('control-format helpers', () => {
  it('converts KB/s <-> Mbps accurately on Tenda 128 KB/s = 1 Mbps scale', () => {
    assert.equal(mbpsToKbs(1), 128);
    assert.equal(mbpsToKbs(10), 1280);
    assert.equal(mbpsToKbs(1000), 128000);
    assert.equal(kbsToMbps(512), 4);
    assert.equal(formatSpeedLimitKbs(0), 'Unlimited');
    assert.equal(formatSpeedLimitKbs(512), '512 KB/s (4 Mbps)');
    assert.equal(formatSpeedLimitKbs(625), '625 KB/s (4.9 Mbps)');
    assert.equal(formatDevicePolicyBadge(625, 64), '↓ 625 · ↑ 64 KB/s');
    assert.equal(formatDevicePolicyBadge(0, 0), 'Unlimited');
  });
});

describe('queries & live merge for QoS + Multi-WAN + Auto-SD + AIC8800 fallback', () => {
  it('exposes QoS limits, WAN bindings, and Auto-SD quarantine state in queries', () => {
    const devices = getLatestDevices();
    const ps5 = devices.find((d) => d.mac === 'AA:BB:CC:DD:EE:01');
    assert.ok(ps5);
    assert.equal(ps5.download_limit_kbs, 625);
    assert.equal(ps5.upload_limit_kbs, 64);
    assert.equal(ps5.qos_known, 1);
    assert.equal(ps5.wan_port, 'WAN2');
    assert.equal(ps5.wan_group_name, 'playstation');

    const guest = devices.find((d) => d.mac === 'AA:BB:CC:DD:EE:99');
    assert.ok(guest);
    assert.equal(guest.auto_qos_state, 'applied');
    assert.equal(guest.download_limit_kbs, 256);
    assert.equal(guest.upload_limit_kbs, 64);

    const single = getDevice('AA:BB:CC:DD:EE:01') as any;
    assert.equal(single.download_limit_kbs, 625);
    assert.equal(single.wan_port, 'WAN2');

    const summary = getNetworkControlSummary();
    assert.equal(summary.qos_policy, 2);
    assert.equal(summary.wan_route_policy, 'custom');
    assert.equal(summary.limited_devices_count, 2);
    assert.equal(summary.pinned_devices_count, 1);
    assert.equal(summary.wan_ports.length, 2);
    assert.equal(summary.wan_ports[1]?.pinned_device_count, 1);
    assert.deepEqual(summary.auto_qos_policy, {
      enabled: true,
      auto_reserve: true,
      download_limit_kbs: 256,
      upload_limit_kbs: 64,
      quarantined_count: 1,
    });
  });

  it('merges live AIC8800 fallback camera speed onto canonical camera MAC and updates offline host limits', () => {
    const devices = getLatestDevices();
    const merged = mergeRouterLiveDevices(devices, {
      ts: Date.now(),
      source: 'router-direct',
      devices: [
        {
          mac: '88:00:33:77:AA:11',
          ip: '192.168.0.32',
          hostname: 'IPC',
          router_remark: null,
          online: 1,
          up_speed_bps: 98304,
          down_speed_bps: 4096,
          down_sum_kb: 900,
          connect_type: 3,
          online_seconds: 120,
          download_limit_kbs: 0,
          upload_limit_kbs: 0,
        },
      ],
      all_hosts_limits: new Map([
        ['AA:BB:CC:DD:EE:01', { download_limit_kbs: 1280, upload_limit_kbs: 128 }],
      ]),
      all_devices_down_bps: 4096,
      all_devices_up_bps: 98304,
      counter_down_bps: 0,
      wan_down_bps: 4096,
      wan_up_bps: 98304,
      best_down_bps: 4096,
      best_up_bps: 98304,
    });

    const camera = merged.find((d) => d.mac === '50:0F:F5:B2:F2:D0');
    assert.ok(camera);
    assert.equal(camera.online, 1);
    assert.equal(camera.up_speed_bps, 98304);

    const ps5 = merged.find((d) => d.mac === 'AA:BB:CC:DD:EE:01');
    assert.ok(ps5);
    assert.equal(ps5.online, 0);
    assert.equal(ps5.download_limit_kbs, 1280);
    assert.equal(ps5.upload_limit_kbs, 128);
  });
});

describe('/api/devices/[mac]/control & /api/network-control routes', () => {
  it('blocks unauthenticated requests with 401', async () => {
    const unauth = new Request('https://tv-eg.com:2055/api/devices/AA:BB:CC:DD:EE:01/control', {
      method: 'POST',
      headers: { host: 'tv-eg.com:2055', origin: 'https://tv-eg.com:2055', 'content-type': 'application/json' },
      body: JSON.stringify({ download_limit_kbs: 512 }),
    });
    const resp = await postDeviceControl(unauth, { params: Promise.resolve({ mac: 'AA:BB:CC:DD:EE:01' }) });
    assert.equal(resp.status, 401);
  });

  it('rejects out-of-range speed limits and missing IP WAN binding cleanly', async () => {
    const badSpeed = makeAuthedRequest('/api/devices/AA:BB:CC:DD:EE:01/control', 'POST', {
      download_limit_kbs: 999_999,
    });
    const badResp = await postDeviceControl(badSpeed, { params: Promise.resolve({ mac: 'AA:BB:CC:DD:EE:01' }) });
    assert.equal(badResp.status, 400);

    const noIpWan = makeAuthedRequest('/api/devices/AA:BB:CC:DD:EE:99/control', 'POST', {
      wan_port: 'WAN1',
    });
    const noIpResp = await postDeviceControl(noIpWan, { params: Promise.resolve({ mac: 'AA:BB:CC:DD:EE:99' }) });
    assert.equal(noIpResp.status, 400);
    const noIpJson = await noIpResp.json();
    assert.equal(noIpJson.code, 'MISSING_DEVICE_IP');
  });

  it('forwards valid speed + 2-stage WAN group + DHCP reservation updates and Auto-SD/Reserve policy cleanly', async () => {
    lastControlPayload = null;
    const req = makeAuthedRequest('/api/devices/AA:BB:CC:DD:EE:01/control', 'POST', {
      download_limit_kbs: 1280,
      upload_limit_kbs: 128,
      wan_port: 'WAN1',
      wan_group_name: 'ps5_living',
      dhcp_reserved: true,
    });
    const resp = await postDeviceControl(req, { params: Promise.resolve({ mac: 'AA:BB:CC:DD:EE:01' }) });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.deepEqual(lastControlPayload, {
      mac: 'AA:BB:CC:DD:EE:01',
      dhcpReserved: true,
      downloadLimitKBs: 1280,
      uploadLimitKBs: 128,
      ip: '192.168.0.167',
      wanPort: 'WAN1',
      wanGroupName: 'ps5_living',
      labelHint: 'بلايستيشن الصالة',
    });

    const netPost = makeAuthedRequest('/api/network-control', 'POST', {
      enabled: true,
      auto_reserve: true,
      download_limit_kbs: 256,
      upload_limit_kbs: 64,
    });
    const netPostResp = await postNetworkControlRoute(netPost);
    assert.equal(netPostResp.status, 200);
    const netPostJson = await netPostResp.json();
    assert.equal(netPostJson.auto_qos_policy.auto_reserve, true);
    assert.equal(netPostJson.auto_qos_policy.download_limit_kbs, 256);
    assert.equal(netPostJson.auto_qos_policy.upload_limit_kbs, 64);
    assert.deepEqual(lastAutoQosPayload, {
      enabled: true,
      autoReserve: true,
      downloadLimitKBs: 256,
      uploadLimitKBs: 64,
    });

    const unauthNet = new Request('https://tv-eg.com:2055/api/network-control', {
      method: 'GET',
      headers: { host: 'tv-eg.com:2055', origin: 'https://tv-eg.com:2055' },
    });
    const unauthNetResp = await getNetworkControlRoute(unauthNet);
    assert.equal(unauthNetResp.status, 401);

    const netReq = makeAuthedRequest('/api/network-control?refresh=1', 'GET');
    const netResp = await getNetworkControlRoute(netReq);
    assert.equal(netResp.status, 200);
    const netJson = await netResp.json();
    assert.equal(netJson.ok, true);
    assert.equal(netJson.wan_ports.length, 2);
    assert.equal(netJson.wan_ports[0]?.public_ip, '156.196.235.143');
    assert.equal(netJson.wan_ports[0]?.ddns_fqdn, 'w1-testslug.example.net');
    assert.equal(netJson.wan_ports[0]?.ddns_synced_ip, '156.196.235.143');
    assert.equal(netJson.wan_ports[0]?.ddns_last_error, null);
    assert.equal(netJson.wan_ports[1]?.public_ip, '156.196.19.204');
    assert.equal(netJson.wan_ports[1]?.ddns_fqdn, 'w2-testslug.example.net');
    assert.equal(netJson.wan_ports[1]?.ddns_synced_ip, '156.196.19.204');

    // Reject invalid SSH port (< 1024 and !== 22, e.g. port 80)
    const badSshPort = makeAuthedRequest('/api/network-control', 'POST', {
      ssh_access: { enabled: true, target_ip: '192.168.0.7', external_port: 80 },
    });
    const badSshResp = await postNetworkControlRoute(badSshPort);
    assert.equal(badSshResp.status, 400);

    // Enable Dual-WAN SSH port mapping via /api/network-control
    const sshReq = makeAuthedRequest('/api/network-control', 'POST', {
      ssh_access: { enabled: true, target_ip: '192.168.0.7', external_port: 22222, ssh_user: 'michaeltawfik' },
    });
    const sshResp = await postNetworkControlRoute(sshReq);
    assert.equal(sshResp.status, 200);
    const sshJson = await sshResp.json();
    assert.equal(sshJson.ssh_access.enabled, true);
    assert.equal(sshJson.ssh_access.target_ip, '192.168.0.7');
    assert.equal(sshJson.ssh_access.external_port, 22222);
    assert.equal(sshJson.ssh_access.wan1_active, true);
    assert.equal(sshJson.ssh_access.wan2_active, true);
    assert.deepEqual(lastSshAccessPayload, {
      enabled: true,
      targetIp: '192.168.0.7',
      externalPort: 22222,
      sshUser: 'michaeltawfik',
    });

    // Trigger explicit public-IP refresh action
    const refreshReq = makeAuthedRequest('/api/network-control', 'POST', {
      action: 'refresh_public_ips',
    });
    const refreshResp = await postNetworkControlRoute(refreshReq);
    assert.equal(refreshResp.status, 200);
    assert.equal(refreshPublicIpsCount, 1);
  });
});
