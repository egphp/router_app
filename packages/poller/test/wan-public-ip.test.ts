import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { RouterClient } from '../src/router-client.js';
import { startControlServer } from '../src/control-server.js';
import { TelegramNotifier } from '../src/telegram-notifier.js';
import { syncTrafficControlToDb } from '../src/traffic-control.js';
import {
  SshLocalRelay,
  WAN1_PROBE_ENDPOINTS,
  WAN2_PROBE_ENDPOINTS,
  getSshAccessConfig,
  loadCloudflareDdnsConfigFromEnv,
  parseCloudflareTraceIp,
  probeWanPublicIps,
  resolveSymmetricSshVips,
  setSshAccessConfig,
  syncCloudflareWanDns,
  syncPortMappingsToDb,
} from '../src/wan-public-ip.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MockWanSshRouterClient extends RouterClient {
  public calls: Array<{ modules: string[]; body: Record<string, unknown> }> = [];
  public wanInfo: any[] = [
    { ID: 1, wanStatus: 'wired', wanType: 'static', wanIP: '192.168.3.13', wanGateway: '192.168.3.1', wanUpFlux: '12KB/s', wanDownFlux: '64KB/s' },
    { ID: 2, wanStatus: 'wired', wanType: 'static', wanIP: '192.168.2.17', wanGateway: '192.168.2.1', wanUpFlux: '8KB/s', wanDownFlux: '32KB/s' },
  ];
  public staticRoutes: any[] = [];
  public portMappings: any[] = [
    {
      ID: 1,
      portMappingEn: false,
      porMappingtInternal: '22',
      portMappingExternal: '22',
      portMappingProtocol: 0,
      portMappingServer: '192.168.0.7',
      portMappingWan: 0,
    },
  ];
  public dmzEntries: any[] = [
    { ID: 1, dmzEn: true, dmzHost: '192.168.0.7', vpnFilter: false },
    { ID: 2, dmzEn: false, dmzHost: '', vpnFilter: false },
  ];
  public ipGroups: any[] = [];
  public wanRouteRules: any[] = [];
  public wanRoutePolicy: any = { wanRoutePolicyType: 'custom', wanDetectEn: true, wanDetectUrl: '8.8.8.8', wanDetectInterval: 5 };
  public rejectDuplicateInternalPort22 = false;
  private nextRouteId = 10;
  private nextPortMapId = 10;
  private nextIpGroupId = 20;
  private nextWanRuleId = 20;

  constructor() {
    super('192.168.0.1', 'test');
  }

  override async call<T = any>(modules: string[], body: Record<string, unknown>): Promise<T> {
    this.calls.push({ modules, body: structuredClone(body) });
    const out: Record<string, unknown> = {};

    for (const m of modules) {
      if (m === 'getWanInfo') out.getWanInfo = structuredClone(this.wanInfo);
      if (m === 'getStaticRoute') out.getStaticRoute = structuredClone(this.staticRoutes);
      if (m === 'getPortMapping') out.getPortMapping = structuredClone(this.portMappings);
      if (m === 'getDMZ') out.getDMZ = structuredClone(this.dmzEntries);
      if (m === 'getIPGroupList') out.getIPGroupList = structuredClone(this.ipGroups);
      if (m === 'getWanRouteRules') out.getWanRouteRules = structuredClone(this.wanRouteRules);
      if (m === 'getWanRoutePolicy') out.getWanRoutePolicy = structuredClone(this.wanRoutePolicy);
      if (m === 'setWanRoutePolicy') out.setWanRoutePolicy = 0;

      if (m === 'setIPGroupList') {
        const req = body.setIPGroupList as any;
        if (req.type === 'add') {
          this.ipGroups.push({
            ID: this.nextIpGroupId++,
            IPGroupRefer: 0,
            IPGroupDefaultTag: false,
            ...req.data,
          });
        } else if (req.type === 'edit') {
          const idx = this.ipGroups.findIndex((g) => Number(g.ID) === Number(req.data.ID));
          if (idx >= 0) this.ipGroups[idx] = { ...this.ipGroups[idx], ...req.data };
        } else if (req.type === 'delete') {
          const ids = new Set((req.data as number[]).map(Number));
          this.ipGroups = this.ipGroups.filter((g) => !ids.has(Number(g.ID)));
        }
        out.setIPGroupList = 0;
      }

      if (m === 'setWanRouteRules') {
        const req = body.setWanRouteRules as any;
        if (req.type === 'add') {
          this.wanRouteRules.push({ ID: this.nextWanRuleId++, ...req.data });
          const g = this.ipGroups.find((ig) => ig.IPGroupName === req.data.IPGroupName);
          if (g) g.IPGroupRefer = 1;
        } else if (req.type === 'edit') {
          const idx = this.wanRouteRules.findIndex((r) => Number(r.ID) === Number(req.data.ID));
          if (idx >= 0) this.wanRouteRules[idx] = { ...this.wanRouteRules[idx], ...req.data };
        } else if (req.type === 'delete') {
          const ids = new Set((req.data as number[]).map(Number));
          for (const r of this.wanRouteRules) {
            if (ids.has(Number(r.ID))) {
              const g = this.ipGroups.find((ig) => ig.IPGroupName === r.IPGroupName);
              if (g) g.IPGroupRefer = 0;
            }
          }
          this.wanRouteRules = this.wanRouteRules.filter((r) => !ids.has(Number(r.ID)));
        }
        out.setWanRouteRules = 0;
      }

      if (m === 'setStaticRoute') {
        const req = body.setStaticRoute as any;
        if (req.type === 'add') {
          this.staticRoutes.push({ ID: this.nextRouteId++, ...req.data });
          out.setStaticRoute = 0;
        } else if (req.type === 'edit') {
          const idx = this.staticRoutes.findIndex((r) => Number(r.ID) === Number(req.data.ID));
          if (idx >= 0) this.staticRoutes[idx] = { ...this.staticRoutes[idx], ...req.data };
          out.setStaticRoute = 0;
        } else if (req.type === 'delete') {
          const ids = new Set((req.data as number[]).map(Number));
          this.staticRoutes = this.staticRoutes.filter((r) => !ids.has(Number(r.ID)));
          out.setStaticRoute = 0;
        }
      }

      if (m === 'setDMZ') {
        const req = body.setDMZ as any;
        if (req.type === 'edit' && Array.isArray(req.data)) {
          this.dmzEntries = structuredClone(req.data);
          out.setDMZ = 0;
        }
      }

      if (m === 'setPortMapping') {
        const req = body.setPortMapping as any;
        if (req.type === 'add') {
          const d = req.data;
          if (
            this.rejectDuplicateInternalPort22 &&
            this.portMappings.some(
              (pm) =>
                pm.portMappingServer === d.portMappingServer &&
                String(pm.porMappingtInternal) === String(d.porMappingtInternal),
            )
          ) {
            out.setPortMapping = 1;
          } else {
            this.portMappings.push({
              ID: this.nextPortMapId++,
              portMappingEn: true,
              ...d,
            });
            out.setPortMapping = 0;
          }
        } else if (req.type === 'edit') {
          const d = req.data;
          if (
            this.rejectDuplicateInternalPort22 &&
            this.portMappings.some(
              (pm) =>
                Number(pm.ID) !== Number(d.ID) &&
                pm.portMappingServer === d.portMappingServer &&
                String(pm.porMappingtInternal) === String(d.porMappingtInternal),
            )
          ) {
            out.setPortMapping = 1;
          } else {
            const idx = this.portMappings.findIndex((pm) => Number(pm.ID) === Number(d.ID));
            if (idx >= 0) {
              this.portMappings[idx] = { ...this.portMappings[idx], ...d };
            }
            out.setPortMapping = 0;
          }
        } else if (req.type === 'switch') {
          const idx = this.portMappings.findIndex((pm) => Number(pm.ID) === Number(req.data.ID));
          if (idx >= 0) {
            this.portMappings[idx].portMappingEn = Boolean(req.data.portMappingEn);
          }
          out.setPortMapping = 0;
        } else if (req.type === 'delete') {
          const ids = new Set((req.data as number[]).map(Number));
          this.portMappings = this.portMappings.filter((pm) => !ids.has(Number(pm.ID)));
          out.setPortMapping = 0;
        }
      }
    }
    return out as T;
  }
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  const migDir = path.resolve(__dirname, '../../shared/src/migrations');
  for (const file of [
    '001_init.sql',
    '022_router_qos_and_wan_controls.sql',
    '025_wan_public_ip_and_ssh_access.sql',
    '026_cloudflare_ddns_state.sql',
  ]) {
    const full = path.join(migDir, file);
    if (fs.existsSync(full)) {
      db.exec(fs.readFileSync(full, 'utf-8'));
    }
  }
  return db;
}

test('ensureWanProbeStaticRoutes creates /32 probe routes per WAN, updates changed gateways, and skips idempotent passes', async () => {
  const router = new MockWanSshRouterClient();
  const first = await router.ensureWanProbeStaticRoutes();
  assert.equal(first.ok, true);
  assert.equal(router.staticRoutes.length, 4);

  const byIp = new Map(router.staticRoutes.map((r) => [r.staticRouteNet, r]));
  assert.equal(byIp.get(WAN1_PROBE_ENDPOINTS.httpsIp)?.staticRouteWAN, 'WAN1');
  assert.equal(byIp.get(WAN1_PROBE_ENDPOINTS.httpsIp)?.staticRouteGateway, '192.168.3.1');
  assert.equal(byIp.get(WAN1_PROBE_ENDPOINTS.httpsIp)?.staticRouteMask, '255.255.255.255');
  assert.equal(byIp.get(WAN2_PROBE_ENDPOINTS.httpsIp)?.staticRouteWAN, 'WAN2');
  assert.equal(byIp.get(WAN2_PROBE_ENDPOINTS.httpsIp)?.staticRouteGateway, '192.168.2.1');

  // Second pass with no change makes zero setStaticRoute writes
  router.calls = [];
  await router.ensureWanProbeStaticRoutes();
  assert.equal(router.calls.filter((c) => c.modules.includes('setStaticRoute')).length, 0);

  // Gateway change on WAN2 updates existing /32 routes cleanly
  router.wanInfo[1].wanGateway = '192.168.2.254';
  await router.ensureWanProbeStaticRoutes();
  const updatedByIp = new Map(router.staticRoutes.map((r) => [r.staticRouteNet, r]));
  assert.equal(updatedByIp.get(WAN2_PROBE_ENDPOINTS.httpsIp)?.staticRouteGateway, '192.168.2.254');
  assert.equal(updatedByIp.get(WAN2_PROBE_ENDPOINTS.dnsIp)?.staticRouteGateway, '192.168.2.254');
});

test('probeWanPublicIps resolves WAN1 & WAN2 public IPs with fallback, preserves across traffic sync, and alerts on IP rotation', async () => {
  const db = createTestDb();
  const router = new MockWanSshRouterClient();
  const t0 = 1_700_000_000_000;

  syncTrafficControlToDb(
    db,
    {
      qosPolicy: 2,
      wanRoutePolicyType: 'custom',
      wanPorts: [
        { wanId: 1, wanName: 'WAN1', status: 'wired', wanType: 'static', wanIp: '192.168.3.13', wanGateway: '192.168.3.1', upFluxBps: 100, downFluxBps: 200 },
        { wanId: 2, wanName: 'WAN2', status: 'wired', wanType: 'static', wanIp: '192.168.2.17', wanGateway: '192.168.2.1', upFluxBps: 50, downFluxBps: 100 },
      ],
      qosDevices: [],
      wanBindings: [],
    },
    t0,
  );

  assert.equal(
    parseCloudflareTraceIp('fl=29f12\nh=cloudflare-dns.com\nip=156.196.235.143\nts=1700000000.123\n'),
    '156.196.235.143',
  );

  // Pass 1: WAN1 succeeds via HTTPS, WAN2 fails HTTPS and succeeds via DNS fallback
  const r1 = await probeWanPublicIps(db, router, {
    now: t0 + 1000,
    httpsProbeFn: async (ip) => {
      if (ip === WAN1_PROBE_ENDPOINTS.httpsIp) return '156.196.235.143';
      throw new Error('simulated TLS timeout');
    },
    dnsProbeFn: async (dnsServerIp) => {
      if (dnsServerIp === WAN2_PROBE_ENDPOINTS.dnsIp) return '156.196.19.204';
      throw new Error('unexpected dns server');
    },
  });

  assert.equal(r1.get(1), '156.196.235.143');
  assert.equal(r1.get(2), '156.196.19.204');

  // Initial discovery should NOT spam wan_ip_changed alert
  const initialAlerts = db.prepare(`SELECT * FROM alerts WHERE kind = 'wan_ip_changed'`).all();
  assert.equal(initialAlerts.length, 0);

  // Regular syncTrafficControlToDb must preserve public_ip columns!
  syncTrafficControlToDb(
    db,
    {
      qosPolicy: 2,
      wanRoutePolicyType: 'custom',
      wanPorts: [
        { wanId: 1, wanName: 'WAN1', status: 'wired', wanType: 'static', wanIp: '192.168.3.13', wanGateway: '192.168.3.1', upFluxBps: 500, downFluxBps: 900 },
        { wanId: 2, wanName: 'WAN2', status: 'wired', wanType: 'static', wanIp: '192.168.2.17', wanGateway: '192.168.2.1', upFluxBps: 300, downFluxBps: 700 },
      ],
      qosDevices: [],
      wanBindings: [],
    },
    t0 + 5000,
  );

  const persisted = db.prepare(`SELECT wan_id, public_ip FROM router_wan_ports ORDER BY wan_id ASC`).all() as Array<{ wan_id: number; public_ip: string | null }>;
  assert.deepEqual(persisted, [
    { wan_id: 1, public_ip: '156.196.235.143' },
    { wan_id: 2, public_ip: '156.196.19.204' },
  ]);

  // Pass 2: ISP router 1 reboots and rotates WAN1 Public IP -> raises wan_ip_changed alert!
  setSshAccessConfig(db, { enabled: true, targetIp: '192.168.0.7', externalPort: 22222, sshUser: 'michaeltawfik' });
  await probeWanPublicIps(db, router, {
    now: t0 + 60_000,
    httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.240.88' : '156.196.19.204'),
    dnsProbeFn: async () => null,
  });

  const rotatedAlerts = db.prepare(`SELECT kind, payload FROM alerts WHERE kind = 'wan_ip_changed'`).all() as Array<{ kind: string; payload: string }>;
  assert.equal(rotatedAlerts.length, 1);
  const payload = JSON.parse(rotatedAlerts[0]!.payload);
  assert.equal(payload.wanName, 'WAN1');
  assert.equal(payload.previousIp, '156.196.235.143');
  assert.equal(payload.publicIp, '156.196.240.88');
  assert.equal(payload.sshPort, 22222);
});

test('configureSshPortMapping enforces DMZ OFF, maps WAN1 & WAN2 TCP SSH rules, and falls back to internal port 2222 if duplicate 22 is rejected', async () => {
  const db = createTestDb();
  const router = new MockWanSshRouterClient();
  router.rejectDuplicateInternalPort22 = true;

  const res = await router.configureSshPortMapping({
    enabled: true,
    targetIp: '192.168.0.7',
    externalPort: 22222,
    internalPortWan1: 22,
    fallbackInternalPortWan2: 2222,
  });

  assert.equal(res.ok, true);
  assert.equal(res.dmzDisabled, true);
  assert.equal(router.dmzEntries.every((d) => d.dmzEn === false), true);
  assert.equal(res.wan1Rule?.externalPort, 22222);
  assert.equal(res.wan1Rule?.internalPort, 22);
  assert.equal(res.wan1Rule?.protocol, 1);
  assert.equal(res.wan2Rule?.externalPort, 22222);
  assert.equal(res.wan2Rule?.internalPort, 2222);
  assert.equal(res.usedFallbackPortWan2, true);

  const mappings = await router.getPortMappings();
  syncPortMappingsToDb(db, mappings);
  const rows = db.prepare(`SELECT wan_id, server_ip, internal_port, external_port, protocol, enabled FROM router_port_mappings ORDER BY wan_id ASC`).all();
  assert.equal(rows.length, 2);

  // Disabling turns off SSH port mappings cleanly
  const offRes = await router.configureSshPortMapping({
    enabled: false,
    targetIp: '192.168.0.7',
    externalPort: 22222,
  });
  assert.equal(offRes.ok, true);
  assert.equal(router.portMappings.every((pm) => pm.portMappingEn === false), true);

  const cfg = setSshAccessConfig(db, { enabled: true, targetIp: '192.168.0.7', externalPort: 22222, sshUser: 'michaeltawfik' });
  assert.equal(cfg.enabled, true);
  assert.equal(getSshAccessConfig(db).externalPort, 22222);
});

test('SshLocalRelay forwards TCP stream bi-directionally to target sshd port', async () => {
  const upstream = net.createServer((socket) => {
    socket.write('SSH-2.0-OpenSSH_Test\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const relay = new SshLocalRelay(0, '127.0.0.1', upstreamPort, '127.0.0.1');
  const relayPort = await relay.start();
  assert.ok(relayPort > 0);

  const received = await new Promise<string>((resolve, reject) => {
    const client = net.connect(relayPort, '127.0.0.1');
    let buf = '';
    client.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('SSH-2.0-OpenSSH_Test') && !buf.includes('PING')) {
        client.write('PING\r\n');
      } else if (buf.includes('PING')) {
        client.end();
        resolve(buf);
      }
    });
    client.on('error', reject);
  });

  assert.match(received, /SSH-2\.0-OpenSSH_Test/);
  assert.match(received, /PING/);

  await relay.stop();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test('control-server /ssh-access configures router + SQLite cache and TelegramNotifier formats wan_ip_changed', async () => {
  const db = createTestDb();
  const router = new MockWanSshRouterClient();
  const srv = startControlServer(0, router, process.cwd(), undefined, db);
  await new Promise<void>((resolve) => {
    if (srv.listening) resolve();
    else srv.once('listening', () => resolve());
  });
  const port = (srv.address() as net.AddressInfo).port;

  try {
    const blockedBrowser = await fetch(`http://127.0.0.1:${port}/ssh-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(blockedBrowser.status, 403);

    const resp = await fetch(`http://127.0.0.1:${port}/ssh-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        targetIp: '192.168.0.7',
        externalPort: 22222,
        sshUser: 'michaeltawfik',
      }),
    });
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as any;
    assert.equal(json.ok, true);
    assert.equal(json.sshAccess.enabled, true);
    assert.equal(json.sshAccess.externalPort, 22222);
    assert.equal(json.applied.wan1Rule.externalPort, 22222);
    assert.equal(json.applied.wan2Rule.externalPort, 22222);

    const mappedRows = db.prepare(`SELECT * FROM router_port_mappings WHERE enabled = 1`).all();
    assert.equal(mappedRows.length, 2);

    const notifier = new TelegramNotifier(db) as any;
    const msg: string = notifier.formatMessage({
      kind: 'wan_ip_changed',
      mac: null,
      payload: JSON.stringify({
        wanName: 'WAN1',
        previousIp: '156.196.235.143',
        publicIp: '156.196.240.88',
        sshEnabled: true,
        sshPort: 22222,
        sshUser: 'michaeltawfik',
      }),
      created_at: 1_700_000_000_000,
    });
    assert.match(msg, /WAN1/);
    assert.match(msg, /156\.196\.240\.88/);
    assert.match(msg, /ssh -p 22222 michaeltawfik@156\.196\.240\.88/);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('resolveSymmetricSshVips & configureSshPortMapping pin SSH_WAN1 (.241) and SSH_WAN2 (.242) to eliminate Dual-WAN asymmetric routing', async () => {
  const withoutVips = resolveSymmetricSshVips('192.168.0.7', new Set(['192.168.0.7']));
  assert.deepEqual(withoutVips, {
    wan1Ip: '192.168.0.7',
    wan2Ip: '192.168.0.7',
    wan1Vip: '192.168.0.241',
    wan2Vip: '192.168.0.242',
    symmetricVipsActive: false,
  });

  const withVips = resolveSymmetricSshVips('192.168.0.7', new Set(['192.168.0.7', '192.168.0.241', '192.168.0.242']));
  assert.deepEqual(withVips, {
    wan1Ip: '192.168.0.241',
    wan2Ip: '192.168.0.242',
    wan1Vip: '192.168.0.241',
    wan2Vip: '192.168.0.242',
    symmetricVipsActive: true,
  });

  const router = new MockWanSshRouterClient();
  // Pre-seed an active single-IP SSH port map on 192.168.0.7 to prove migration disables stale rules cleanly
  router.portMappings = [
    { ID: 1, portMappingEn: true, porMappingtInternal: '22', portMappingExternal: '22222', portMappingProtocol: 1, portMappingServer: '192.168.0.7', portMappingWan: 0 },
    { ID: 3, portMappingEn: true, porMappingtInternal: '22', portMappingExternal: '22222', portMappingProtocol: 1, portMappingServer: '192.168.0.7', portMappingWan: 1 },
  ];

  const res = await router.configureSshPortMapping({
    enabled: true,
    targetIp: '192.168.0.7',
    wan1TargetIp: withVips.wan1Ip,
    wan2TargetIp: withVips.wan2Ip,
    externalPort: 22222,
  });

  assert.equal(res.ok, true);
  assert.equal(res.wan1Rule?.serverIp, '192.168.0.241');
  assert.equal(res.wan1Rule?.internalPort, 22);
  assert.equal(res.wan2Rule?.serverIp, '192.168.0.242');
  assert.equal(res.wan2Rule?.internalPort, 22);
  assert.equal(res.usedFallbackPortWan2, false);

  // Stale 192.168.0.7 rules must be disabled so WAN1/WAN2 external port 22222 never collides
  const oldRules = router.portMappings.filter((pm) => pm.portMappingServer === '192.168.0.7');
  assert.equal(oldRules.every((pm) => pm.portMappingEn === false), true);

  // Stage 1 + Stage 2 Multi-WAN rules must pin .241 -> WAN1 and .242 -> WAN2
  const wan1Bind = router.wanRouteRules.find((r) => r.IPGroupName === 'ssh_wan1');
  const wan2Bind = router.wanRouteRules.find((r) => r.IPGroupName === 'ssh_wan2');
  assert.equal(wan1Bind?.wanRouteRuleWAN, 'WAN1');
  assert.equal(wan2Bind?.wanRouteRuleWAN, 'WAN2');

  // Disabling cleans up both VIP port mappings and VIP Multi-WAN bindings
  const off = await router.configureSshPortMapping({
    enabled: false,
    targetIp: '192.168.0.7',
    wan1TargetIp: withVips.wan1Ip,
    wan2TargetIp: withVips.wan2Ip,
    externalPort: 22222,
  });
  assert.equal(off.ok, true);
  assert.equal(router.portMappings.every((pm) => pm.portMappingEn === false), true);
  assert.equal(router.wanRouteRules.length, 0);
});

test('syncCloudflareWanDns & probeWanPublicIps manage DNS-Only A records idempotently, no-op without credentials, and redact tokens on error', async () => {
  const db = createTestDb();
  const router = new MockWanSshRouterClient();
  const t0 = 1_700_100_000_000;

  syncTrafficControlToDb(
    db,
    {
      qosPolicy: 2,
      wanRoutePolicyType: 'custom',
      wanPorts: [
        { wanId: 1, wanName: 'WAN1', status: 'wired', wanType: 'static', wanIp: '192.168.3.13', wanGateway: '192.168.3.1', upFluxBps: 100, downFluxBps: 200 },
        { wanId: 2, wanName: 'WAN2', status: 'wired', wanType: 'static', wanIp: '192.168.2.17', wanGateway: '192.168.2.1', upFluxBps: 50, downFluxBps: 100 },
      ],
      qosDevices: [],
      wanBindings: [],
    },
    t0,
  );
  setSshAccessConfig(db, { enabled: true, targetIp: '192.168.0.7', externalPort: 22222, sshUser: 'michaeltawfik' });

  const parsedEnv = loadCloudflareDdnsConfigFromEnv({
    CF_API_TOKEN: 'cf_secret_test_token_999',
    CF_ZONE_ID: 'zone_test_123',
    CF_DDNS_WAN1_FQDN: 'W1-TestSlug.Example.net.',
    CF_DDNS_WAN2_FQDN: 'w2-testslug.example.net',
  });
  assert.equal(parsedEnv.enabled, true);
  assert.equal(parsedEnv.wan1Fqdn, 'w1-testslug.example.net');
  assert.equal(parsedEnv.wan2Fqdn, 'w2-testslug.example.net');

  // External private JSON file (~/.config/egphp-owner/tenda-cloudflare-ddns.json) keeps secrets completely outside repo & .env
  const tmpSecretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-cf-secret-'));
  const secretFile = path.join(tmpSecretDir, 'tenda-cloudflare-ddns.json');
  fs.writeFileSync(
    secretFile,
    JSON.stringify({
      apiToken: 'cf_file_secret_token_888',
      zoneId: 'zone_file_456',
      wan1Fqdn: 'w1-fileslug.example.net',
      wan2Fqdn: 'w2-fileslug.example.net',
    }),
    { mode: 0o600 },
  );
  try {
    const fromFile = loadCloudflareDdnsConfigFromEnv({}, secretFile);
    assert.equal(fromFile.enabled, true);
    assert.equal(fromFile.apiToken, 'cf_file_secret_token_888');
    assert.equal(fromFile.zoneId, 'zone_file_456');
    assert.equal(fromFile.wan1Fqdn, 'w1-fileslug.example.net');
    assert.equal(fromFile.wan2Fqdn, 'w2-fileslug.example.net');
  } finally {
    fs.rmSync(tmpSecretDir, { recursive: true, force: true });
  }

  // 1) PPETO / unconfigured host safety: empty token/zone + missing file makes zero HTTP calls
  let cfCalls: Array<{ url: string; method: string; body: any; auth: string | null }> = [];
  const cfRecords = new Map<string, { id: string; name: string; content: string; ttl: number; proxied: boolean }>();
  let simulate500 = false;

  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
    cfCalls.push({ url, method, body, auth });

    if (simulate500) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: 'upstream error with token cf_secret_test_token_999 in zone_test_123' }] }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const parsedUrl = new URL(url);
    if (method === 'GET' && parsedUrl.pathname.endsWith('/dns_records')) {
      const name = parsedUrl.searchParams.get('name') ?? '';
      const rec = cfRecords.get(name);
      return new Response(JSON.stringify({ success: true, result: rec ? [rec] : [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST' && parsedUrl.pathname.endsWith('/dns_records')) {
      const created = {
        id: `rec_${cfRecords.size + 1}`,
        name: body.name,
        content: body.content,
        ttl: body.ttl,
        proxied: body.proxied,
      };
      cfRecords.set(body.name, created);
      return new Response(JSON.stringify({ success: true, result: created }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'PUT' && parsedUrl.pathname.includes('/dns_records/')) {
      const updated = {
        id: parsedUrl.pathname.split('/').pop()!,
        name: body.name,
        content: body.content,
        ttl: body.ttl,
        proxied: body.proxied,
      };
      cfRecords.set(body.name, updated);
      return new Response(JSON.stringify({ success: true, result: updated }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };

  await probeWanPublicIps(db, router, {
    now: t0 + 1000,
    httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.235.143' : '156.196.19.204'),
    dnsProbeFn: async () => null,
    ddnsConfig: loadCloudflareDdnsConfigFromEnv({}, '/nonexistent/cf-ddns-secret.json'),
    ddnsFetchFn: mockFetch,
  });
  assert.equal(cfCalls.length, 0);

  // 2) Initial Cloudflare creation: creates DNS-Only (proxied: false, ttl: 60) A records for WAN1 & WAN2
  await probeWanPublicIps(db, router, {
    now: t0 + 2000,
    httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.235.143' : '156.196.19.204'),
    dnsProbeFn: async () => null,
    ddnsConfig: parsedEnv,
    ddnsFetchFn: mockFetch,
  });

  assert.equal(cfRecords.get('w1-testslug.example.net')?.content, '156.196.235.143');
  assert.equal(cfRecords.get('w1-testslug.example.net')?.proxied, false);
  assert.equal(cfRecords.get('w1-testslug.example.net')?.ttl, 60);
  assert.equal(cfRecords.get('w2-testslug.example.net')?.content, '156.196.19.204');
  assert.equal(cfRecords.get('w2-testslug.example.net')?.proxied, false);

  // Regular syncTrafficControlToDb must preserve ddns_* columns
  syncTrafficControlToDb(
    db,
    {
      qosPolicy: 2,
      wanRoutePolicyType: 'custom',
      wanPorts: [
        { wanId: 1, wanName: 'WAN1', status: 'wired', wanType: 'static', wanIp: '192.168.3.13', wanGateway: '192.168.3.1', upFluxBps: 500, downFluxBps: 900 },
        { wanId: 2, wanName: 'WAN2', status: 'wired', wanType: 'static', wanIp: '192.168.2.17', wanGateway: '192.168.2.1', upFluxBps: 300, downFluxBps: 700 },
      ],
      qosDevices: [],
      wanBindings: [],
    },
    t0 + 5000,
  );

  const syncedRows = db
    .prepare(`SELECT wan_id, ddns_fqdn, ddns_synced_ip, ddns_last_error FROM router_wan_ports ORDER BY wan_id ASC`)
    .all() as Array<{ wan_id: number; ddns_fqdn: string | null; ddns_synced_ip: string | null; ddns_last_error: string | null }>;
  assert.deepEqual(syncedRows, [
    { wan_id: 1, ddns_fqdn: 'w1-testslug.example.net', ddns_synced_ip: '156.196.235.143', ddns_last_error: null },
    { wan_id: 2, ddns_fqdn: 'w2-testslug.example.net', ddns_synced_ip: '156.196.19.204', ddns_last_error: null },
  ]);

  // 3) Idempotent next minute: zero Cloudflare API calls when IPs are unchanged within re-verify window
  cfCalls = [];
  await probeWanPublicIps(db, router, {
    now: t0 + 62_000,
    httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.235.143' : '156.196.19.204'),
    dnsProbeFn: async () => null,
    ddnsConfig: parsedEnv,
    ddnsFetchFn: mockFetch,
  });
  assert.equal(cfCalls.length, 0);

  // 4) ISP rotates WAN1 IP -> immediately PUTs new IP (proxied: false, ttl: 60) and emits wan_ip_changed with ddnsFqdn
  cfCalls = [];
  await probeWanPublicIps(db, router, {
    now: t0 + 120_000,
    httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.250.77' : '156.196.19.204'),
    dnsProbeFn: async () => null,
    ddnsConfig: parsedEnv,
    ddnsFetchFn: mockFetch,
  });
  assert.equal(cfRecords.get('w1-testslug.example.net')?.content, '156.196.250.77');
  assert.equal(cfRecords.get('w1-testslug.example.net')?.proxied, false);
  assert.equal(cfCalls.some((c) => c.method === 'PUT'), true);

  const alertRow = db
    .prepare(`SELECT payload, created_at FROM alerts WHERE kind = 'wan_ip_changed' ORDER BY id DESC LIMIT 1`)
    .get() as { payload: string; created_at: number } | undefined;
  assert.ok(alertRow);
  const parsedAlert = JSON.parse(alertRow.payload);
  assert.equal(parsedAlert.ddnsFqdn, 'w1-testslug.example.net');
  assert.equal(parsedAlert.ddnsSynced, true);

  const notifier = new TelegramNotifier(db) as any;
  const tgMsg: string = notifier.formatMessage({
    kind: 'wan_ip_changed',
    mac: null,
    payload: alertRow.payload,
    created_at: alertRow.created_at,
  });
  assert.match(tgMsg, /w1-testslug\.example\.net/);
  assert.match(tgMsg, /ssh -p 22222 michaeltawfik@w1-testslug\.example\.net/);

  // 5) Transient Cloudflare 500 error: stores redacted error (never leaks CF_API_TOKEN or CF_ZONE_ID)
  simulate500 = true;
  await syncCloudflareWanDns(db, parsedEnv, { now: t0 + 180_000, force: true, fetchFn: mockFetch });
  const errRow = db
    .prepare(`SELECT ddns_last_error, ddns_synced_ip FROM router_wan_ports WHERE wan_id = 1`)
    .get() as { ddns_last_error: string | null; ddns_synced_ip: string | null };
  assert.ok(errRow.ddns_last_error);
  assert.equal(errRow.ddns_last_error.includes('cf_secret_test_token_999'), false);
  assert.equal(errRow.ddns_last_error.includes('zone_test_123'), false);
  // Previous synced IP remains intact during transient error
  assert.equal(errRow.ddns_synced_ip, '156.196.250.77');
});

test('syncCloudflareWanDns supports tokenless ssh-relay mode so CF_API_TOKEN never leaves the IP-allowlisted server', async () => {
  const db = createTestDb();
  const router = new MockWanSshRouterClient();
  const t0 = 1_700_200_000_000;

  syncTrafficControlToDb(
    db,
    {
      qosPolicy: 2,
      wanRoutePolicyType: 'custom',
      wanPorts: [
        { wanId: 1, wanName: 'WAN1', status: 'wired', wanType: 'static', wanIp: '192.168.3.13', wanGateway: '192.168.3.1', upFluxBps: 100, downFluxBps: 200 },
        { wanId: 2, wanName: 'WAN2', status: 'wired', wanType: 'static', wanIp: '192.168.2.17', wanGateway: '192.168.2.1', upFluxBps: 50, downFluxBps: 100 },
      ],
      qosDevices: [],
      wanBindings: [],
    },
    t0,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-ssh-relay-'));
  const relayCfgFile = path.join(tmpDir, 'ddns.json');
  fs.writeFileSync(
    relayCfgFile,
    JSON.stringify({
      sshHost: 'relay-box',
      remoteScript: '/opt/secrets/ddns_sync.php',
      wan1Fqdn: 'w1-relay.example.net',
      wan2Fqdn: 'w2-relay.example.net',
    }),
    { mode: 0o600 },
  );

  try {
    const relayCfg = loadCloudflareDdnsConfigFromEnv({}, relayCfgFile);
    assert.equal(relayCfg.enabled, true);
    assert.equal(relayCfg.mode, 'ssh-relay');
    assert.equal(relayCfg.apiToken, '');
    assert.equal(relayCfg.zoneId, '');
    assert.equal(relayCfg.sshHost, 'relay-box');
    assert.equal(relayCfg.remoteScript, '/opt/secrets/ddns_sync.php');

    const sshCalls: Array<{ sshHost: string; remoteScript: string; fqdn: string; ip: string }> = [];
    const mockSshExec = async (sshHost: string, remoteScript: string, fqdn: string, ip: string) => {
      sshCalls.push({ sshHost, remoteScript, fqdn, ip });
      return { ok: true as const };
    };

    await probeWanPublicIps(db, router, {
      now: t0 + 1000,
      httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.235.143' : '156.196.19.204'),
      dnsProbeFn: async () => null,
      ddnsConfig: relayCfg,
      ddnsSshExecFn: mockSshExec,
    });

    assert.equal(sshCalls.length, 2);
    const rows = db
      .prepare(`SELECT wan_id, ddns_fqdn, ddns_synced_ip, ddns_last_error FROM router_wan_ports ORDER BY wan_id ASC`)
      .all();
    assert.deepEqual(rows, [
      { wan_id: 1, ddns_fqdn: 'w1-relay.example.net', ddns_synced_ip: '156.196.235.143', ddns_last_error: null },
      { wan_id: 2, ddns_fqdn: 'w2-relay.example.net', ddns_synced_ip: '156.196.19.204', ddns_last_error: null },
    ]);

    // Subsequent poll with unchanged IPs skips SSH relay completely
    sshCalls.length = 0;
    await probeWanPublicIps(db, router, {
      now: t0 + 61_000,
      httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.235.143' : '156.196.19.204'),
      dnsProbeFn: async () => null,
      ddnsConfig: relayCfg,
      ddnsSshExecFn: mockSshExec,
    });
    assert.equal(sshCalls.length, 0);

    // Unapproved subdomain rotation attempt is strictly blocked; pinned hostnames remain immutable
    const driftedCfg = loadCloudflareDdnsConfigFromEnv({
      CF_DDNS_SSH_HOST: 'relay-box',
      CF_DDNS_REMOTE_SCRIPT: '/opt/secrets/ddns_sync.php',
      CF_DDNS_WAN1_FQDN: 'w1-rotated.example.net',
      CF_DDNS_WAN2_FQDN: 'w2-rotated.example.net',
    });
    assert.equal(Boolean(driftedCfg.allowFqdnChange), false);

    sshCalls.length = 0;
    await probeWanPublicIps(db, router, {
      now: t0 + 120_000,
      httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.240.99' : '156.196.20.88'),
      dnsProbeFn: async () => null,
      ddnsConfig: driftedCfg,
      ddnsSshExecFn: mockSshExec,
    });
    assert.equal(sshCalls.length, 0);

    const lockedRows = db
      .prepare(`SELECT wan_id, ddns_fqdn, ddns_synced_ip, ddns_last_error FROM router_wan_ports ORDER BY wan_id ASC`)
      .all() as Array<{ wan_id: number; ddns_fqdn: string | null; ddns_synced_ip: string | null; ddns_last_error: string | null }>;
    assert.equal(lockedRows[0]?.ddns_fqdn, 'w1-relay.example.net');
    assert.equal(lockedRows[1]?.ddns_fqdn, 'w2-relay.example.net');
    assert.match(lockedRows[0]?.ddns_last_error ?? '', /Pinned DDNS hostname locked to w1-relay\.example\.net/);
    assert.match(lockedRows[1]?.ddns_last_error ?? '', /Pinned DDNS hostname locked to w2-relay\.example\.net/);

    // Restoring the pinned hostnames immediately syncs the new ISP IPs and clears the lock warning
    await probeWanPublicIps(db, router, {
      now: t0 + 125_000,
      httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.240.99' : '156.196.20.88'),
      dnsProbeFn: async () => null,
      ddnsConfig: relayCfg,
      ddnsSshExecFn: mockSshExec,
    });
    assert.equal(sshCalls.length, 2);
    const recoveredRows = db
      .prepare(`SELECT wan_id, ddns_fqdn, ddns_synced_ip, ddns_last_error FROM router_wan_ports ORDER BY wan_id ASC`)
      .all();
    assert.deepEqual(recoveredRows, [
      { wan_id: 1, ddns_fqdn: 'w1-relay.example.net', ddns_synced_ip: '156.196.240.99', ddns_last_error: null },
      { wan_id: 2, ddns_fqdn: 'w2-relay.example.net', ddns_synced_ip: '156.196.20.88', ddns_last_error: null },
    ]);

    // Explicit CF_DDNS_ALLOW_FQDN_CHANGE=1 permits intentional owner migration
    const approvedCfg = loadCloudflareDdnsConfigFromEnv({
      CF_DDNS_SSH_HOST: 'relay-box',
      CF_DDNS_REMOTE_SCRIPT: '/opt/secrets/ddns_sync.php',
      CF_DDNS_WAN1_FQDN: 'w1-intentional.example.net',
      CF_DDNS_WAN2_FQDN: 'w2-intentional.example.net',
      CF_DDNS_ALLOW_FQDN_CHANGE: '1',
    });
    assert.equal(approvedCfg.allowFqdnChange, true);
    sshCalls.length = 0;
    await probeWanPublicIps(db, router, {
      now: t0 + 130_000,
      httpsProbeFn: async (ip) => (ip === WAN1_PROBE_ENDPOINTS.httpsIp ? '156.196.240.99' : '156.196.20.88'),
      dnsProbeFn: async () => null,
      ddnsConfig: approvedCfg,
      ddnsSshExecFn: mockSshExec,
    });
    assert.equal(sshCalls.length, 2);
    const migratedRows = db
      .prepare(`SELECT wan_id, ddns_fqdn, ddns_synced_ip, ddns_last_error FROM router_wan_ports ORDER BY wan_id ASC`)
      .all();
    assert.deepEqual(migratedRows, [
      { wan_id: 1, ddns_fqdn: 'w1-intentional.example.net', ddns_synced_ip: '156.196.240.99', ddns_last_error: null },
      { wan_id: 2, ddns_fqdn: 'w2-intentional.example.net', ddns_synced_ip: '156.196.20.88', ddns_last_error: null },
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
