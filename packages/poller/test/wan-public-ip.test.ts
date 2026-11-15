import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
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
  parseCloudflareTraceIp,
  probeWanPublicIps,
  setSshAccessConfig,
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
  public rejectDuplicateInternalPort22 = false;
  private nextRouteId = 10;
  private nextPortMapId = 10;

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
