import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  buildSafeIpGroupName,
  enqueueNewDeviceForAutoQos,
  getNewDeviceAutoQosConfig,
  markDeviceAutoQosReviewed,
  processPendingAutoQos,
  resolveIpWanBindings,
  setNewDeviceAutoQosConfig,
  syncTrafficControlToDb,
} from '../src/traffic-control.js';
import { Accumulator } from '../src/accumulator.js';
import { RouterClient } from '../src/router-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MockRouterClient extends RouterClient {
  public calls: Array<{ modules: string[]; body: Record<string, unknown> }> = [];
  public qosPolicy = { qosPolicy: 2 };
  public wanAutoSpeed = [
    { ID: 1, wanUpstream: 300, wanDownstream: 300 },
    { ID: 2, wanUpstream: 300, wanDownstream: 300 },
  ];
  public qosUsers: any[] = [
    {
      ID: 553,
      hostIP: '192.168.0.2',
      hostMAC: '2A:CB:4D:89:5A:30',
      hostName: 'iPhone',
      hostRemark: 'ميلانيا',
      hostUploadSpeed: 4,
      hostDownloadSpeed: 20,
      hostConnectCount: 8,
      hostDownloadSum: 1024,
      hostConnectType: 4,
      hostUploadLimit: 64,
      hostDownloadLimit: 625,
      onlineTime: 12,
      hostAuthType: '',
      authUserName: '',
      hostOnlineStatus: 1,
    },
    {
      ID: 748,
      hostIP: '192.168.0.118',
      hostMAC: '1E:C0:7A:60:57:CA',
      hostName: 'iPhone',
      hostRemark: 'مارلي',
      hostDownloadSum: 2048,
      hostUploadLimit: 64,
      hostDownloadLimit: 625,
      hostOffLineTime: '2026-11-15 03:00:00',
      hostOnlineStatus: 0,
    },
  ];
  public wanInfo: any[] = [
    { ID: 1, wanStatus: 'wired', wanType: 'static', wanIP: '192.168.3.13', wanGateway: '192.168.3.1', wanUpFlux: '10KB/s', wanDownFlux: '50KB/s' },
    { ID: 2, wanStatus: 'wired', wanType: 'static', wanIP: '192.168.2.17', wanGateway: '192.168.2.1', wanUpFlux: '5KB/s', wanDownFlux: '25KB/s' },
  ];
  public wanRoutePolicy = { wanRoutePolicyType: 'custom', wanDetectEn: true, wanDetectUrl: '8.8.8.8', wanDetectInterval: 5 };
  public ipGroups: any[] = [
    { ID: 2, IPGroupRefer: 1, IPGroupName: 'wafaa', IPGroupDefaultTag: false, IPGroupStartIP: '192.168.0.82', IPGroupEndIP: '192.168.0.82' },
    { ID: 9, IPGroupRefer: 1, IPGroupName: 'iot_range', IPGroupDefaultTag: false, IPGroupStartIP: '192.168.0.200', IPGroupEndIP: '192.168.0.205' },
  ];
  public wanRules: any[] = [
    { ID: 1, IPGroupName: 'wafaa', wanRouteRuleEn: true, wanRouteRuleWAN: 'WAN1' },
    { ID: 2, IPGroupName: 'iot_range', wanRouteRuleEn: true, wanRouteRuleWAN: 'WAN2' },
  ];
  public lanIpMask = { lanIP: '192.168.0.1', lanMask: '255.255.255.0' };
  public dhcpStaticBinds: any[] = [
    { ID: 1, enableStatus: true, bindMACAddr: '50:0F:F5:B2:F2:D0', bindIPAddr: '192.168.0.32', bindRemark: 'door' },
    { ID: 2, enableStatus: true, bindMACAddr: '3A:CB:5F:7D:4B:A7', bindIPAddr: '192.168.0.7', bindRemark: 'mac_studio' },
  ];
  public dhcpClients: any[] = [
    { ID: 1, bindStatus: true, bindMACAddr: '5C:AD:BA:6D:14:3F', bindIPAddr: '192.168.0.88', hostName: 'iPhone17promax' },
    { ID: 2, bindStatus: false, bindMACAddr: '2A:CB:4D:89:5A:30', bindIPAddr: '192.168.0.2', hostName: 'iPhone' },
  ];
  private nextGroupId = 20;
  private nextRuleId = 20;
  private nextStaticBindId = 20;

  constructor() {
    super('192.168.0.1', 'test');
  }

  override async call<T = any>(modules: string[], body: Record<string, unknown>): Promise<T> {
    this.calls.push({ modules: [...modules], body: structuredClone(body) });
    const out: Record<string, unknown> = {};

    if ('setQosPolicy' in body && body.setQosPolicy) {
      this.qosPolicy = body.setQosPolicy as any;
    }
    if ('setQosUserList' in body && body.setQosUserList) {
      const p = body.setQosUserList as { type: string; actionFlag: number; data: Array<{ ID: number; hostRemark: string; hostUploadLimit: number; hostDownloadLimit: number }> };
      for (const item of p.data) {
        const found = this.qosUsers.find((u) => u.ID === item.ID);
        if (found) {
          found.hostRemark = item.hostRemark;
          found.hostUploadLimit = item.hostUploadLimit;
          found.hostDownloadLimit = item.hostDownloadLimit;
        }
      }
      out.setQosUserList = 0;
    }
    if ('setIPGroupList' in body && body.setIPGroupList) {
      const p = body.setIPGroupList as { type: string; data: any };
      if (p.type === 'add') {
        this.ipGroups.push({
          ID: this.nextGroupId++,
          IPGroupRefer: 0,
          IPGroupName: p.data.IPGroupName,
          IPGroupDefaultTag: false,
          IPGroupStartIP: p.data.IPGroupStartIP,
          IPGroupEndIP: p.data.IPGroupEndIP,
        });
      } else if (p.type === 'edit') {
        const g = this.ipGroups.find((x) => x.ID === p.data.ID);
        if (g) {
          g.IPGroupName = p.data.IPGroupName;
          g.IPGroupStartIP = p.data.IPGroupStartIP;
          g.IPGroupEndIP = p.data.IPGroupEndIP;
        }
      } else if (p.type === 'delete') {
        const ids = new Set<number>(p.data);
        this.ipGroups = this.ipGroups.filter((g) => !ids.has(g.ID));
      }
      out.setIPGroupList = 0;
    }
    if ('setWanRoutePolicy' in body && body.setWanRoutePolicy) {
      this.wanRoutePolicy = { ...this.wanRoutePolicy, ...(body.setWanRoutePolicy as any) };
      out.setWanRoutePolicy = 0;
    }
    if ('setWanRouteRules' in body && body.setWanRouteRules) {
      const p = body.setWanRouteRules as { type: string; data: any };
      if (p.type === 'add') {
        this.wanRules.push({
          ID: this.nextRuleId++,
          IPGroupName: p.data.IPGroupName,
          wanRouteRuleEn: Boolean(p.data.wanRouteRuleEn),
          wanRouteRuleWAN: p.data.wanRouteRuleWAN,
        });
        const g = this.ipGroups.find((x) => x.IPGroupName === p.data.IPGroupName);
        if (g) g.IPGroupRefer += 1;
      } else if (p.type === 'edit') {
        const r = this.wanRules.find((x) => x.ID === p.data.ID);
        if (r) {
          r.wanRouteRuleEn = Boolean(p.data.wanRouteRuleEn);
          r.wanRouteRuleWAN = p.data.wanRouteRuleWAN;
          r.IPGroupName = p.data.IPGroupName;
        }
      } else if (p.type === 'delete') {
        const ids = new Set<number>(p.data);
        for (const r of this.wanRules) {
          if (ids.has(r.ID)) {
            const g = this.ipGroups.find((x) => x.IPGroupName === r.IPGroupName);
            if (g && g.IPGroupRefer > 0) g.IPGroupRefer -= 1;
          }
        }
        this.wanRules = this.wanRules.filter((r) => !ids.has(r.ID));
      }
      out.setWanRouteRules = 0;
    }

    if (modules.includes('getQosPolicy')) out.getQosPolicy = structuredClone(this.qosPolicy);
    if (modules.includes('getWanAutoSpeed')) out.getWanAutoSpeed = structuredClone(this.wanAutoSpeed);
    if (modules.includes('getQosUserList')) out.getQosUserList = structuredClone(this.qosUsers);
    if (modules.includes('getWanInfo')) out.getWanInfo = structuredClone(this.wanInfo);
    if (modules.includes('getWanRoutePolicy')) out.getWanRoutePolicy = structuredClone(this.wanRoutePolicy);
    if (modules.includes('getWanRouteRules')) out.getWanRouteRules = structuredClone(this.wanRules);
    if (modules.includes('getIPGroupList')) out.getIPGroupList = structuredClone(this.ipGroups);
    if ('setDhcpStaticBindList' in body && body.setDhcpStaticBindList) {
      const p = body.setDhcpStaticBindList as { type: string; data: any };
      if (p.type === 'add') {
        for (const item of p.data) {
          this.dhcpStaticBinds.push({
            ID: this.nextStaticBindId++,
            enableStatus: true,
            bindIPAddr: item.bindIPAddr,
            bindMACAddr: String(item.bindMACAddr).toUpperCase(),
            bindRemark: item.bindRemark ?? '',
          });
        }
      } else if (p.type === 'edit') {
        const found = this.dhcpStaticBinds.find((x) => x.ID === Number(p.data.ID));
        if (found) {
          found.bindIPAddr = p.data.bindIPAddr;
          found.bindMACAddr = String(p.data.bindMACAddr).toUpperCase();
          found.bindRemark = p.data.bindRemark ?? '';
        }
      } else if (p.type === 'switch') {
        const found = this.dhcpStaticBinds.find((x) => x.ID === Number(p.data.ID));
        if (found) found.enableStatus = Boolean(p.data.enableStatus);
      } else if (p.type === 'delete') {
        const ids = new Set<number>(p.data.map(Number));
        this.dhcpStaticBinds = this.dhcpStaticBinds.filter((x) => !ids.has(x.ID));
      }
      out.setDhcpStaticBindList = 0;
    }
    if (modules.includes('getLanIpMask')) out.getLanIpMask = structuredClone(this.lanIpMask);
    if (modules.includes('getDhcpStaticBindList')) out.getDhcpStaticBindList = structuredClone(this.dhcpStaticBinds);
    if (modules.includes('getDhcpClientList')) out.getDhcpClientList = structuredClone(this.dhcpClients);

    return out as T;
  }
}

test('buildSafeIpGroupName creates <=16 char ASCII router-safe names and avoids collisions', () => {
  assert.equal(buildSafeIpGroupName('Wafaa iPad', '192.168.0.91', new Set()), 'wafaa_ipad');
  assert.equal(buildSafeIpGroupName('ميلانيا', '192.168.0.2', new Set()), 'dev_192_168_0_2');
  const collided = buildSafeIpGroupName('wafaa', '192.168.0.82', new Set(['wafaa']));
  assert.notEqual(collided, 'wafaa');
  assert.ok(collided.length <= 16);
  assert.match(collided, /^[a-zA-Z0-9_]{1,16}$/);
});

test('resolveIpWanBindings resolves both single-IP and range IP groups accurately', () => {
  const mock = new MockRouterClient();
  const map = resolveIpWanBindings(mock.ipGroups, mock.wanRules);

  assert.equal(map.get('192.168.0.82')?.wanPort, 'WAN1');
  assert.equal(map.get('192.168.0.82')?.inheritedFromRange, false);

  assert.equal(map.get('192.168.0.203')?.wanPort, 'WAN2');
  assert.equal(map.get('192.168.0.203')?.inheritedFromRange, true);
  assert.equal(map.get('192.168.0.50'), undefined);
});

test('setDeviceSpeedLimit uses actionFlag 5 for online and actionFlag 6 for offline while preserving hostRemark', async () => {
  const mock = new MockRouterClient();

  const resOnline = await mock.setDeviceSpeedLimit({
    mac: '2a:cb:4d:89:5a:30',
    downloadLimitKBs: 1250,
    uploadLimitKBs: 128,
  });
  assert.equal(resOnline.ok, true);
  const writeOnline = mock.calls.find((c) => c.modules.includes('setQosUserList'))!;
  assert.equal((writeOnline.body.setQosUserList as any).actionFlag, 5);
  assert.deepEqual((writeOnline.body.setQosUserList as any).data[0], {
    ID: 553,
    hostRemark: 'ميلانيا',
    hostUploadLimit: 128,
    hostDownloadLimit: 1250,
  });

  mock.calls = [];
  const resOffline = await mock.setDeviceSpeedLimit({
    mac: '1E:C0:7A:60:57:CA',
    downloadLimitKBs: 0,
    uploadLimitKBs: 0,
  });
  assert.equal(resOffline.ok, true);
  const writeOffline = mock.calls.find((c) => c.modules.includes('setQosUserList'))!;
  assert.equal((writeOffline.body.setQosUserList as any).actionFlag, 6);
  assert.deepEqual((writeOffline.body.setQosUserList as any).data[0], {
    ID: 748,
    hostRemark: 'مارلي',
    hostUploadLimit: 0,
    hostDownloadLimit: 0,
  });

  const missing = await mock.setDeviceSpeedLimit({
    mac: 'AA:BB:CC:DD:EE:FF',
    downloadLimitKBs: 512,
    uploadLimitKBs: 64,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_IN_ROUTER_QOS_TABLE');
});

test('setDeviceWanBinding adds, edits, cleans up single-IP bindings, and protects shared IP ranges', async () => {
  const mock = new MockRouterClient();

  // 1. Add new single-WAN binding for 192.168.0.55 when router starts in 'auto' mode + custom groupName
  mock.wanRoutePolicy.wanRoutePolicyType = 'auto';
  const added = await mock.setDeviceWanBinding({
    ip: '192.168.0.55',
    labelHint: 'Office Mac',
    groupName: 'office_mac',
    wanPort: 'WAN2',
  });
  assert.equal(added.ok, true);
  assert.equal(mock.wanRoutePolicy.wanRoutePolicyType, 'custom');
  assert.equal(mock.ipGroups.some((g) => g.IPGroupName === 'office_mac' && g.IPGroupStartIP === '192.168.0.55' && g.IPGroupEndIP === '192.168.0.55'), true);
  assert.equal(mock.wanRules.some((r) => r.IPGroupName === 'office_mac' && r.wanRouteRuleWAN === 'WAN2' && r.wanRouteRuleEn === true), true);

  // 1b. Rename IP group & switch WAN2 -> WAN1 in 2 stages cleanly
  const renamed = await mock.setDeviceWanBinding({
    ip: '192.168.0.55',
    groupName: 'pro_workstation',
    wanPort: 'WAN1',
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.applied?.ipGroupName, 'pro_workstation');
  assert.equal(mock.ipGroups.some((g) => g.IPGroupName === 'pro_workstation' && g.IPGroupStartIP === '192.168.0.55'), true);
  assert.equal(mock.ipGroups.some((g) => g.IPGroupName === 'office_mac'), false);
  assert.equal(mock.wanRules.some((r) => r.IPGroupName === 'pro_workstation' && r.wanRouteRuleWAN === 'WAN1' && r.wanRouteRuleEn === true), true);

  // 2. Edit existing user binding (192.168.0.82 'wafaa') WAN1 -> WAN2 preserving 'wafaa' name when groupName omitted
  const edited = await mock.setDeviceWanBinding({
    ip: '192.168.0.82',
    labelHint: 'Wafaa Phone',
    wanPort: 'WAN2',
  });
  assert.equal(edited.ok, true);
  const wafaaRule = mock.wanRules.find((r) => r.IPGroupName === 'wafaa');
  assert.equal(wafaaRule?.wanRouteRuleWAN, 'WAN2');

  // 3. Reset 192.168.0.55 back to 'auto' -> deletes rule AND unreferenced single-IP group
  const cleared = await mock.setDeviceWanBinding({
    ip: '192.168.0.55',
    labelHint: 'Office Mac',
    wanPort: 'auto',
  });
  assert.equal(cleared.ok, true);
  assert.equal(mock.wanRules.some((r) => r.IPGroupName === 'pro_workstation'), false);
  assert.equal(mock.ipGroups.some((g) => g.IPGroupName === 'pro_workstation'), false);

  // 4. Protect shared multi-IP range group (192.168.0.200~205)
  const rangeAttempt = await mock.setDeviceWanBinding({
    ip: '192.168.0.202',
    labelHint: 'IoT Plug',
    wanPort: 'auto',
  });
  assert.equal(rangeAttempt.ok, false);
  assert.equal(rangeAttempt.code, 'SHARED_IP_RANGE_RULE');
});

test('syncTrafficControlToDb persists QoS limits, WAN ports, and WAN bindings cleanly', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../shared/src/migrations/022_router_qos_and_wan_controls.sql'),
    'utf-8',
  );
  db.exec(sql);

  const mock = new MockRouterClient();
  const state = await mock.getTrafficControlState();
  syncTrafficControlToDb(db, state, 1_700_000_000_000);

  const qosRows = db.prepare(`SELECT * FROM router_qos_limits ORDER BY mac`).all() as any[];
  assert.equal(qosRows.length, 2);
  assert.equal(qosRows[0].download_limit_kbs, 625);

  const wanPorts = db.prepare(`SELECT * FROM router_wan_ports ORDER BY wan_id`).all() as any[];
  assert.equal(wanPorts.length, 2);
  assert.equal(wanPorts[0].wan_name, 'WAN1');
  assert.equal(wanPorts[0].down_flux_bps, 50 * 1024);

  const bindings = db.prepare(`SELECT * FROM router_wan_bindings WHERE ip = '192.168.0.82'`).get() as any;
  assert.equal(bindings.wan_port, 'WAN1');
  assert.equal(bindings.ip_group_name, 'wafaa');
});

test('getDhcpReservations merges static + client lists, and set/removeDeviceDhcpReservation manages router reservations safely', async () => {
  const mock = new MockRouterClient();

  // 1. Merges getDhcpStaticBindList (offline/manual) + getDhcpClientList (active)
  const allRes = await mock.getDhcpReservations();
  assert.equal(allRes.length, 3);
  assert.equal(allRes.some((r) => r.bindMACAddr === '3A:CB:5F:7D:4B:A7' && r.bindIPAddr === '192.168.0.7'), true);
  assert.equal(allRes.some((r) => r.bindMACAddr === '5C:AD:BA:6D:14:3F' && r.bindIPAddr === '192.168.0.88'), true);

  // 2. Add static DHCP reservation for unreserved device
  const added = await mock.setDeviceDhcpReservation({
    mac: '2a:cb:4d:89:5a:30',
    ip: '192.168.0.2',
    remark: 'ميلانيا جهاز شخصي طويل جدا للاختبار 123456',
  });
  assert.equal(added.ok, true);
  assert.equal(added.applied?.ip, '192.168.0.2');
  assert.ok(Buffer.byteLength(added.applied?.remark ?? '', 'utf-8') <= 32);
  assert.equal(mock.dhcpStaticBinds.some((x) => x.bindMACAddr === '2A:CB:4D:89:5A:30' && x.bindIPAddr === '192.168.0.2'), true);

  // 3. Idempotent when already reserved to same IP
  const again = await mock.setDeviceDhcpReservation({
    mac: '2A:CB:4D:89:5A:30',
    ip: '192.168.0.2',
    remark: 'ميلانيا',
  });
  assert.equal(again.ok, true);

  // 4. Rejects IP already reserved to another MAC
  const conflict = await mock.setDeviceDhcpReservation({
    mac: 'AA:BB:CC:11:22:33',
    ip: '192.168.0.32',
    remark: 'intruder',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'IP_ALREADY_RESERVED');

  // 5. Rejects AIC8800 camera boot-fallback MAC
  const fallback = await mock.setDeviceDhcpReservation({
    mac: '88:00:33:77:AA:BB',
    ip: '192.168.0.199',
    remark: 'IPC',
  });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.code, 'AIC8800_FALLBACK_MAC');

  // 6. Remove static DHCP reservation cleanly
  const removed = await mock.removeDeviceDhcpReservation({ mac: '2A:CB:4D:89:5A:30' });
  assert.equal(removed.ok, true);
  assert.equal(mock.dhcpStaticBinds.some((x) => x.bindMACAddr === '2A:CB:4D:89:5A:30'), false);
});

test('auto-SD speed cap (256 down / 64 up KB/s) + automatic DHCP reservation handle new devices until reviewed, ignoring AIC8800 fallback', async () => {
  const { runMigrations } = await import('@tenda/shared');
  const db = new Database(':memory:');
  runMigrations(db);

  // 1. Verify default SD + Auto-Reserve config (enabled, autoReserve, 256 KB/s down, 64 KB/s up)
  const cfg = getNewDeviceAutoQosConfig(db);
  assert.deepEqual(cfg, { enabled: true, autoReserve: true, downloadLimitKBs: 256, uploadLimitKBs: 64 });

  // Seed canonical camera so 88:00:33:77:* fallback is recognized
  const now = 1_700_000_010_000;
  db.prepare(`
    INSERT INTO devices (mac, hostname, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
    VALUES ('50:0F:F5:B2:F2:D0', 'IPC', 'Tenda', 'camera', ?, ?, 0, ?, ?)
  `).run(now, now, now, now);
  db.prepare(`
    INSERT INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb)
    VALUES ('50:0F:F5:B2:F2:D0', ?, '192.168.0.32', 1, 1024, 1024, 100)
  `).run(now);

  const mock = new MockRouterClient();
  // Add a brand-new guest phone (limits currently 0/0), an AIC8800 fallback MAC, and a pre-limited device
  mock.qosUsers.push(
    {
      ID: 901,
      hostIP: '192.168.0.145',
      hostMAC: 'AA:11:22:33:44:55',
      hostName: 'Guest-Phone',
      hostRemark: '',
      hostUploadSpeed: 2,
      hostDownloadSpeed: 10,
      hostDownloadSum: 50,
      hostConnectType: 4,
      hostUploadLimit: 0,
      hostDownloadLimit: 0,
      onlineTime: 1,
      hostOnlineStatus: 1,
    },
    {
      ID: 902,
      hostIP: '192.168.0.32',
      hostMAC: '88:00:33:77:BE:EF',
      hostName: 'IPC',
      hostRemark: '',
      hostUploadSpeed: 12,
      hostDownloadSpeed: 1,
      hostDownloadSum: 10,
      hostConnectType: 3,
      hostUploadLimit: 0,
      hostDownloadLimit: 0,
      onlineTime: 1,
      hostOnlineStatus: 1,
    },
    {
      ID: 903,
      hostIP: '192.168.0.146',
      hostMAC: 'AA:11:22:33:44:66',
      hostName: 'Already-Capped-TV',
      hostRemark: 'tv_guest',
      hostUploadSpeed: 1,
      hostDownloadSpeed: 5,
      hostDownloadSum: 20,
      hostConnectType: 4,
      hostUploadLimit: 32,
      hostDownloadLimit: 512,
      onlineTime: 1,
      hostOnlineStatus: 1,
    },
  );

  const acc = new Accumulator(db);
  const res = acc.process(now + 10_000, mock.qosUsers, false);

  // Only non-AIC8800 unknown MACs are new
  assert.equal(res.newDevices.includes('AA:11:22:33:44:55'), true);
  assert.equal(res.newDevices.includes('88:00:33:77:BE:EF'), false);

  // Process pending auto-QoS rules against the mock router
  mock.calls = [];
  const applied = await processPendingAutoQos(db, mock, now + 10_000);

  // Guest-Phone got capped to 256 KB/s down / 64 KB/s up AND reserved to 192.168.0.145 automatically!
  assert.deepEqual(applied.get('AA:11:22:33:44:55'), {
    downloadLimitKBs: 256,
    uploadLimitKBs: 64,
    reservedIp: '192.168.0.145',
  });
  const guestOnRouter = mock.qosUsers.find((u) => u.hostMAC === 'AA:11:22:33:44:55');
  assert.equal(guestOnRouter.hostDownloadLimit, 256);
  assert.equal(guestOnRouter.hostUploadLimit, 64);
  assert.equal(
    mock.dhcpStaticBinds.some((b) => b.bindMACAddr === 'AA:11:22:33:44:55' && b.bindIPAddr === '192.168.0.145' && b.enableStatus === true),
    true,
  );
  const localRsv = db.prepare(`SELECT ip FROM dhcp_reservations WHERE mac = 'AA:11:22:33:44:55'`).get() as any;
  assert.equal(localRsv?.ip, '192.168.0.145');

  // Pre-limited TV kept its 512 / 32 manual cap untouched, while STILL getting its IP 192.168.0.146 auto-reserved!
  assert.deepEqual(applied.get('AA:11:22:33:44:66'), {
    downloadLimitKBs: null,
    uploadLimitKBs: null,
    reservedIp: '192.168.0.146',
  });
  const tvOnRouter = mock.qosUsers.find((u) => u.hostMAC === 'AA:11:22:33:44:66');
  assert.equal(tvOnRouter.hostDownloadLimit, 512);
  assert.equal(tvOnRouter.hostUploadLimit, 32);
  assert.equal(
    mock.dhcpStaticBinds.some((b) => b.bindMACAddr === 'AA:11:22:33:44:66' && b.bindIPAddr === '192.168.0.146' && b.enableStatus === true),
    true,
  );

  // AIC8800 camera fallback was never queued or reserved!
  const camRow = db.prepare(`SELECT * FROM device_auto_qos WHERE mac = '88:00:33:77:BE:EF'`).get();
  assert.equal(camRow, undefined);
  assert.equal(mock.dhcpStaticBinds.some((b) => b.bindMACAddr === '88:00:33:77:BE:EF'), false);

  // Owner reviews and unlimits Guest-Phone -> marked 'reviewed' and never re-capped
  markDeviceAutoQosReviewed(db, 'AA:11:22:33:44:55', now + 20_000);
  const guestAutoRow = db.prepare(`SELECT * FROM device_auto_qos WHERE mac = 'AA:11:22:33:44:55'`).get() as any;
  assert.equal(guestAutoRow.state, 'reviewed');

  const secondPass = await processPendingAutoQos(db, mock, now + 30_000);
  assert.equal(secondPass.size, 0);

  // Updating config persists custom values cleanly
  const updatedCfg = setNewDeviceAutoQosConfig(db, { enabled: false, autoReserve: false, downloadLimitKBs: 512, uploadLimitKBs: 128 });
  assert.deepEqual(updatedCfg, { enabled: false, autoReserve: false, downloadLimitKBs: 512, uploadLimitKBs: 128 });
  const notQueuedWhenDisabled = enqueueNewDeviceForAutoQos(db, 'BB:CC:DD:EE:FF:00', 0, 0, now + 40_000);
  assert.equal(notQueuedWhenDisabled, false);
});
