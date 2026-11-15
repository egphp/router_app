import net from 'node:net';
import type Database from 'better-sqlite3';
import {
  isAic8800FallbackMac,
  type NewDeviceAutoQosConfig,
  type RouterDevice,
  type RouterQosDeviceLimit,
  type RouterTrafficControlState,
  type RouterWanIpBinding,
  type RouterWanPortState,
} from '@tenda/shared';
import type { RouterClient } from './router-client.js';

export const MAX_ROUTER_SPEED_LIMIT_KBS = 128_000;
export const MAX_ROUTER_IP_GROUP_LEN = 16;
export const MAX_ROUTER_DHCP_STATIC_BINDS = 200;
export const MAX_ROUTER_DHCP_REMARK_BYTES = 32;

export const DEFAULT_NEW_DEVICE_AUTO_QOS: NewDeviceAutoQosConfig = {
  enabled: true,
  autoReserve: true,
  downloadLimitKBs: 256,
  uploadLimitKBs: 64,
};

const KV_AUTO_QOS_ENABLED = 'router.auto_qos_new_devices.enabled';
const KV_AUTO_RESERVE_ENABLED = 'router.auto_qos_new_devices.auto_reserve';
const KV_AUTO_QOS_DOWN_KBS = 'router.auto_qos_new_devices.download_kbs';
const KV_AUTO_QOS_UP_KBS = 'router.auto_qos_new_devices.upload_kbs';

export interface RawRouterIpGroup {
  ID: number;
  IPGroupRefer?: number;
  IPGroupName: string;
  IPGroupDefaultTag?: boolean;
  IPGroupStartIP: string;
  IPGroupEndIP: string;
}

export interface RawRouterWanRule {
  ID: number;
  IPGroupName: string;
  wanRouteRuleEn: boolean;
  wanRouteRuleWAN: string;
}

export function ipv4ToInt(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

export function intToIpv4(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join('.');
}

export function isValidLanIpv4(ip: unknown): ip is string {
  if (typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  if (!net.isIPv4(trimmed)) return false;
  const [a, b] = trimmed.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Build a router-safe `IPGroupName` (`1..16` chars `[a-zA-Z0-9_]`, unique against `existingNames`).
 * Tenda W30E `ipTimeGroup.js` enforces `{ type: "username", args: [1, 16] }`.
 */
export function buildSafeIpGroupName(
  labelHint: string | null | undefined,
  ip: string,
  existingNames: Set<string>,
): string {
  const lowerExisting = new Set([...existingNames].map((n) => n.toLowerCase()));
  const cleanedLabel = (labelHint ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const ipOctets = ip.trim().replace(/\./g, '_');
  const fallbackBase = `dev_${ipOctets}`.slice(0, MAX_ROUTER_IP_GROUP_LEN).replace(/_+$/g, '') || `ip_${ip.split('.').pop() ?? 'x'}`;
  const base = (cleanedLabel.length >= 2 ? cleanedLabel : fallbackBase)
    .slice(0, MAX_ROUTER_IP_GROUP_LEN)
    .replace(/_+$/g, '');

  if (base && !lowerExisting.has(base.toLowerCase())) {
    return base;
  }

  for (let suffix = 1; suffix <= 999; suffix++) {
    const tag = `_${suffix}`;
    const stem = (base || 'dev').slice(0, MAX_ROUTER_IP_GROUP_LEN - tag.length).replace(/_+$/g, '') || 'd';
    const candidate = `${stem}${tag}`;
    if (!lowerExisting.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `d_${Date.now().toString(36)}`.slice(0, MAX_ROUTER_IP_GROUP_LEN);
}

/**
 * Expand `getIPGroupList` + `getWanRouteRules` into a lookup map keyed by IPv4.
 * Explicit single-IP rules always take precedence over broader multi-IP range rules.
 */
export function resolveIpWanBindings(
  ipGroups: RawRouterIpGroup[],
  wanRules: RawRouterWanRule[],
): Map<string, RouterWanIpBinding> {
  const groupByName = new Map<string, RawRouterIpGroup>();
  for (const g of ipGroups) {
    if (g && typeof g.IPGroupName === 'string') {
      groupByName.set(g.IPGroupName, g);
    }
  }

  const out = new Map<string, RouterWanIpBinding>();

  // Pass 1: range groups (up to /24 = 256 IPs to guard against `:full:` 0.0.0.0~255.255.255.255).
  for (const rule of wanRules) {
    if (!rule || !rule.wanRouteRuleEn) continue;
    const group = groupByName.get(rule.IPGroupName);
    if (!group) continue;
    if (group.IPGroupName === ':full:' || group.IPGroupName === ':all:wifi:guest:') continue;
    const start = ipv4ToInt(group.IPGroupStartIP);
    const end = ipv4ToInt(group.IPGroupEndIP);
    if (start === null || end === null || end < start) continue;
    if (start === end) continue;
    const count = end - start + 1;
    if (count > 256) continue;
    for (let cur = start; cur <= end; cur++) {
      const ip = intToIpv4(cur);
      if (!out.has(ip)) {
        out.set(ip, {
          ip,
          wanPort: String(rule.wanRouteRuleWAN || '').toUpperCase(),
          ruleId: Number(rule.ID),
          ruleEnabled: Boolean(rule.wanRouteRuleEn),
          ipGroupId: Number(group.ID),
          ipGroupName: group.IPGroupName,
          startIp: group.IPGroupStartIP,
          endIp: group.IPGroupEndIP,
          inheritedFromRange: true,
        });
      }
    }
  }

  // Pass 2: explicit single-IP groups override range rules.
  for (const rule of wanRules) {
    if (!rule || !rule.wanRouteRuleEn) continue;
    const group = groupByName.get(rule.IPGroupName);
    if (!group) continue;
    if (group.IPGroupStartIP !== group.IPGroupEndIP) continue;
    const ip = group.IPGroupStartIP.trim();
    if (!net.isIPv4(ip)) continue;
    out.set(ip, {
      ip,
      wanPort: String(rule.wanRouteRuleWAN || '').toUpperCase(),
      ruleId: Number(rule.ID),
      ruleEnabled: Boolean(rule.wanRouteRuleEn),
      ipGroupId: Number(group.ID),
      ipGroupName: group.IPGroupName,
      startIp: ip,
      endIp: ip,
      inheritedFromRange: false,
    });
  }

  return out;
}

export function normalizeQosDevices(rows: RouterDevice[] | Array<Record<string, unknown>>): RouterQosDeviceLimit[] {
  const out: RouterQosDeviceLimit[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const mac = String(r.hostMAC ?? '').trim().toUpperCase();
    if (!mac || isAic8800FallbackMac(mac)) continue;
    const routerId = Number(r.ID ?? 0);
    if (!Number.isFinite(routerId)) continue;
    const ip = typeof r.hostIP === 'string' && r.hostIP.trim() ? r.hostIP.trim() : null;
    const routerRemark = typeof r.hostRemark === 'string' && r.hostRemark.trim() ? r.hostRemark.trim() : null;
    const online: 0 | 1 = Number(r.hostOnlineStatus ?? 0) === 1 ? 1 : 0;
    const downloadLimitKBs = Math.max(0, Math.round(Number(r.hostDownloadLimit ?? 0) || 0));
    const uploadLimitKBs = Math.max(0, Math.round(Number(r.hostUploadLimit ?? 0) || 0));
    out.push({
      mac,
      routerId,
      ip,
      routerRemark,
      online,
      downloadLimitKBs,
      uploadLimitKBs,
    });
  }
  return out;
}

export function normalizeWanPorts(
  rows: Array<Record<string, unknown>> | undefined,
  parseFlux: (v: string | undefined) => number,
): RouterWanPortState[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((w, idx) => {
    const wanId = Number(w.ID ?? idx + 1);
    return {
      wanId,
      wanName: `WAN${wanId}`,
      status: String(w.wanStatus ?? 'unknown'),
      wanType: typeof w.wanType === 'string' ? w.wanType : null,
      wanIp: typeof w.wanIP === 'string' && w.wanIP !== '0.0.0.0' ? w.wanIP : null,
      wanGateway: typeof w.wanGateway === 'string' && w.wanGateway !== '0.0.0.0' ? w.wanGateway : null,
      upFluxBps: parseFlux(typeof w.wanUpFlux === 'string' ? w.wanUpFlux : undefined),
      downFluxBps: parseFlux(typeof w.wanDownFlux === 'string' ? w.wanDownFlux : undefined),
    };
  });
}

export function syncQosDevicesToDb(
  db: Database.Database,
  qosDevices: RouterQosDeviceLimit[],
  now = Date.now(),
): void {
  const upsert = db.prepare(`
    INSERT INTO router_qos_limits (mac, router_id, ip, router_remark, online, download_limit_kbs, upload_limit_kbs, updated_at)
    VALUES (@mac, @router_id, @ip, @router_remark, @online, @download_limit_kbs, @upload_limit_kbs, @updated_at)
    ON CONFLICT(mac) DO UPDATE SET
      router_id = excluded.router_id,
      ip = COALESCE(excluded.ip, router_qos_limits.ip),
      router_remark = excluded.router_remark,
      online = excluded.online,
      download_limit_kbs = excluded.download_limit_kbs,
      upload_limit_kbs = excluded.upload_limit_kbs,
      updated_at = excluded.updated_at
  `);
  const deleteMissing = db.prepare(`
    DELETE FROM router_qos_limits WHERE mac NOT IN (SELECT value FROM json_each(?))
  `);

  const macs = qosDevices.map((d) => d.mac);
  const txn = db.transaction(() => {
    for (const d of qosDevices) {
      upsert.run({
        mac: d.mac,
        router_id: d.routerId,
        ip: d.ip,
        router_remark: d.routerRemark,
        online: d.online,
        download_limit_kbs: d.downloadLimitKBs,
        upload_limit_kbs: d.uploadLimitKBs,
        updated_at: now,
      });
    }
    deleteMissing.run(JSON.stringify(macs));
  });
  txn();
}

export function syncTrafficControlToDb(
  db: Database.Database,
  state: RouterTrafficControlState,
  now = Date.now(),
): void {
  const upsertWanPort = db.prepare(`
    INSERT INTO router_wan_ports (wan_id, wan_name, status, wan_type, wan_ip, wan_gateway, up_flux_bps, down_flux_bps, updated_at)
    VALUES (@wan_id, @wan_name, @status, @wan_type, @wan_ip, @wan_gateway, @up_flux_bps, @down_flux_bps, @updated_at)
    ON CONFLICT(wan_id) DO UPDATE SET
      wan_name = excluded.wan_name,
      status = excluded.status,
      wan_type = excluded.wan_type,
      wan_ip = excluded.wan_ip,
      wan_gateway = excluded.wan_gateway,
      up_flux_bps = excluded.up_flux_bps,
      down_flux_bps = excluded.down_flux_bps,
      updated_at = excluded.updated_at
  `);
  const deleteMissingPorts = db.prepare(`
    DELETE FROM router_wan_ports WHERE wan_id NOT IN (SELECT value FROM json_each(?))
  `);

  const upsertBinding = db.prepare(`
    INSERT INTO router_wan_bindings (
      ip, wan_port, rule_id, rule_enabled, ip_group_id, ip_group_name, start_ip, end_ip, inherited_from_range, updated_at
    ) VALUES (
      @ip, @wan_port, @rule_id, @rule_enabled, @ip_group_id, @ip_group_name, @start_ip, @end_ip, @inherited_from_range, @updated_at
    )
    ON CONFLICT(ip) DO UPDATE SET
      wan_port = excluded.wan_port,
      rule_id = excluded.rule_id,
      rule_enabled = excluded.rule_enabled,
      ip_group_id = excluded.ip_group_id,
      ip_group_name = excluded.ip_group_name,
      start_ip = excluded.start_ip,
      end_ip = excluded.end_ip,
      inherited_from_range = excluded.inherited_from_range,
      updated_at = excluded.updated_at
  `);
  const deleteMissingBindings = db.prepare(`
    DELETE FROM router_wan_bindings WHERE ip NOT IN (SELECT value FROM json_each(?))
  `);

  const upsertKv = db.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const txn = db.transaction(() => {
    syncQosDevicesToDb(db, state.qosDevices, now);

    const wanIds = state.wanPorts.map((p) => p.wanId);
    for (const p of state.wanPorts) {
      upsertWanPort.run({
        wan_id: p.wanId,
        wan_name: p.wanName,
        status: p.status,
        wan_type: p.wanType,
        wan_ip: p.wanIp,
        wan_gateway: p.wanGateway,
        up_flux_bps: p.upFluxBps,
        down_flux_bps: p.downFluxBps,
        updated_at: now,
      });
    }
    deleteMissingPorts.run(JSON.stringify(wanIds));

    const ips = state.wanBindings.map((b) => b.ip);
    for (const b of state.wanBindings) {
      upsertBinding.run({
        ip: b.ip,
        wan_port: b.wanPort,
        rule_id: b.ruleId,
        rule_enabled: b.ruleEnabled ? 1 : 0,
        ip_group_id: b.ipGroupId,
        ip_group_name: b.ipGroupName,
        start_ip: b.startIp,
        end_ip: b.endIp,
        inherited_from_range: b.inheritedFromRange ? 1 : 0,
        updated_at: now,
      });
    }
    deleteMissingBindings.run(JSON.stringify(ips));

    upsertKv.run('router.qos_policy', String(state.qosPolicy));
    upsertKv.run('router.wan_route_policy', state.wanRoutePolicyType);
  });
  txn();
}

export function sanitizeRouterRemark(remark: string, maxBytes = 63): string {
  const clean = remark.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (Buffer.byteLength(clean, 'utf-8') <= maxBytes) return clean;
  let out = '';
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch, 'utf-8') > maxBytes) break;
    out += ch;
  }
  return out;
}

export function sanitizeDhcpBindRemark(remark: string | null | undefined): string {
  return sanitizeRouterRemark(remark ?? '', MAX_ROUTER_DHCP_REMARK_BYTES);
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!hasTable(db, tableName)) return false;
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

export function getNewDeviceAutoQosConfig(db: Database.Database): NewDeviceAutoQosConfig {
  if (!hasTable(db, 'kv')) {
    return { ...DEFAULT_NEW_DEVICE_AUTO_QOS };
  }
  const rows = db
    .prepare(`SELECT key, value FROM kv WHERE key IN (?, ?, ?, ?)`)
    .all(KV_AUTO_QOS_ENABLED, KV_AUTO_RESERVE_ENABLED, KV_AUTO_QOS_DOWN_KBS, KV_AUTO_QOS_UP_KBS) as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const rawEnabled = map.get(KV_AUTO_QOS_ENABLED);
  const enabled = rawEnabled === undefined ? DEFAULT_NEW_DEVICE_AUTO_QOS.enabled : rawEnabled !== '0' && rawEnabled !== 'false';

  const rawAutoReserve = map.get(KV_AUTO_RESERVE_ENABLED);
  const autoReserve = rawAutoReserve === undefined ? DEFAULT_NEW_DEVICE_AUTO_QOS.autoReserve : rawAutoReserve !== '0' && rawAutoReserve !== 'false';

  const rawDown = map.get(KV_AUTO_QOS_DOWN_KBS);
  const parsedDown = rawDown === undefined ? DEFAULT_NEW_DEVICE_AUTO_QOS.downloadLimitKBs : Math.round(Number(rawDown));
  const downloadLimitKBs = Number.isFinite(parsedDown) && parsedDown >= 0 && parsedDown <= MAX_ROUTER_SPEED_LIMIT_KBS
    ? parsedDown
    : DEFAULT_NEW_DEVICE_AUTO_QOS.downloadLimitKBs;

  const rawUp = map.get(KV_AUTO_QOS_UP_KBS);
  const parsedUp = rawUp === undefined ? DEFAULT_NEW_DEVICE_AUTO_QOS.uploadLimitKBs : Math.round(Number(rawUp));
  const uploadLimitKBs = Number.isFinite(parsedUp) && parsedUp >= 0 && parsedUp <= MAX_ROUTER_SPEED_LIMIT_KBS
    ? parsedUp
    : DEFAULT_NEW_DEVICE_AUTO_QOS.uploadLimitKBs;

  return { enabled, autoReserve, downloadLimitKBs, uploadLimitKBs };
}

export function setNewDeviceAutoQosConfig(
  db: Database.Database,
  patch: Partial<NewDeviceAutoQosConfig>,
): NewDeviceAutoQosConfig {
  const current = getNewDeviceAutoQosConfig(db);
  const next: NewDeviceAutoQosConfig = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    autoReserve: patch.autoReserve !== undefined ? Boolean(patch.autoReserve) : current.autoReserve,
    downloadLimitKBs:
      patch.downloadLimitKBs !== undefined
        ? Math.max(0, Math.min(MAX_ROUTER_SPEED_LIMIT_KBS, Math.round(Number(patch.downloadLimitKBs) || 0)))
        : current.downloadLimitKBs,
    uploadLimitKBs:
      patch.uploadLimitKBs !== undefined
        ? Math.max(0, Math.min(MAX_ROUTER_SPEED_LIMIT_KBS, Math.round(Number(patch.uploadLimitKBs) || 0)))
        : current.uploadLimitKBs,
  };

  const upsert = db.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const txn = db.transaction(() => {
    upsert.run(KV_AUTO_QOS_ENABLED, next.enabled ? '1' : '0');
    upsert.run(KV_AUTO_RESERVE_ENABLED, next.autoReserve ? '1' : '0');
    upsert.run(KV_AUTO_QOS_DOWN_KBS, String(next.downloadLimitKBs));
    upsert.run(KV_AUTO_QOS_UP_KBS, String(next.uploadLimitKBs));
  });
  txn();
  return next;
}

/**
 * Queue a newly discovered genuine LAN device for automatic SD speed capping
 * (`256 KB/s` down / `64 KB/s` up by default) and/or automatic DHCP Address Reservation
 * until the owner reviews it.
 */
export function enqueueNewDeviceForAutoQos(
  db: Database.Database,
  mac: string,
  existingRouterDownKBs = 0,
  existingRouterUpKBs = 0,
  now = Date.now(),
): boolean {
  const macUp = mac.trim().toUpperCase();
  if (!macUp || isAic8800FallbackMac(macUp)) return false;
  if (!hasTable(db, 'device_auto_qos')) return false;

  const cfg = getNewDeviceAutoQosConfig(db);
  const wantsQos = cfg.enabled && (cfg.downloadLimitKBs > 0 || cfg.uploadLimitKBs > 0);
  const wantsReserve = cfg.autoReserve;

  if (!wantsQos && !wantsReserve) {
    return false;
  }

  const hasExistingManualQos = existingRouterDownKBs > 0 || existingRouterUpKBs > 0;
  const qosState = wantsQos ? (hasExistingManualQos ? 'skipped' : 'pending') : 'skipped';
  const targetDown = qosState === 'pending' ? cfg.downloadLimitKBs : existingRouterDownKBs;
  const targetUp = qosState === 'pending' ? cfg.uploadLimitKBs : existingRouterUpKBs;
  const reserveState = wantsReserve ? 'pending' : 'skipped';

  if (hasColumn(db, 'device_auto_qos', 'reserve_state')) {
    const res = db.prepare(`
      INSERT INTO device_auto_qos (
        mac, state, target_down_kbs, target_up_kbs, attempts, reserve_state, reserve_attempts, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)
      ON CONFLICT(mac) DO NOTHING
    `).run(macUp, qosState, targetDown, targetUp, reserveState, now, now);
    return res.changes > 0 && (qosState === 'pending' || reserveState === 'pending');
  }

  if (qosState !== 'pending') {
    db.prepare(`
      INSERT INTO device_auto_qos (mac, state, target_down_kbs, target_up_kbs, attempts, created_at, updated_at)
      VALUES (?, 'skipped', ?, ?, 0, ?, ?)
      ON CONFLICT(mac) DO NOTHING
    `).run(macUp, targetDown, targetUp, now, now);
    return false;
  }

  const res = db.prepare(`
    INSERT INTO device_auto_qos (mac, state, target_down_kbs, target_up_kbs, attempts, created_at, updated_at)
    VALUES (?, 'pending', ?, ?, 0, ?, ?)
    ON CONFLICT(mac) DO NOTHING
  `).run(macUp, targetDown, targetUp, now, now);

  return res.changes > 0;
}

export interface AutoQosAppliedOutcome {
  downloadLimitKBs: number | null;
  uploadLimitKBs: number | null;
  reservedIp: string | null;
}

/**
 * Apply pending auto-QoS caps and automatic DHCP Reservations on the live router
 * (with bounded retries across poll ticks).
 * Returns a map of MACs that were newly capped and/or reserved on this pass.
 */
export async function processPendingAutoQos(
  db: Database.Database,
  router: Pick<RouterClient, 'setDeviceSpeedLimit'> & Partial<Pick<RouterClient, 'setDeviceDhcpReservation'>>,
  now = Date.now(),
): Promise<Map<string, AutoQosAppliedOutcome>> {
  const applied = new Map<string, AutoQosAppliedOutcome>();
  if (!hasTable(db, 'device_auto_qos')) return applied;

  const supportsReserveCol = hasColumn(db, 'device_auto_qos', 'reserve_state');
  const cutoff = now - 24 * 60 * 60 * 1000;

  const pending = supportsReserveCol
    ? (db.prepare(`
        SELECT mac, state, target_down_kbs, target_up_kbs, attempts, reserve_state, reserve_attempts
        FROM device_auto_qos
        WHERE ((state = 'pending' AND attempts < 12) OR (reserve_state = 'pending' AND reserve_attempts < 12))
          AND created_at >= ?
        ORDER BY created_at ASC
        LIMIT 10
      `).all(cutoff) as Array<{
        mac: string;
        state: string;
        target_down_kbs: number;
        target_up_kbs: number;
        attempts: number;
        reserve_state: string;
        reserve_attempts: number;
      }>)
    : (db.prepare(`
        SELECT mac, state, target_down_kbs, target_up_kbs, attempts, 'skipped' AS reserve_state, 0 AS reserve_attempts
        FROM device_auto_qos
        WHERE state = 'pending' AND attempts < 12 AND created_at >= ?
        ORDER BY created_at ASC
        LIMIT 10
      `).all(cutoff) as Array<{
        mac: string;
        state: string;
        target_down_kbs: number;
        target_up_kbs: number;
        attempts: number;
        reserve_state: string;
        reserve_attempts: number;
      }>);

  if (pending.length === 0) return applied;

  const markQosApplied = db.prepare(`
    UPDATE device_auto_qos
    SET state = 'applied',
        attempts = attempts + 1,
        last_error = NULL,
        applied_at = ?,
        updated_at = ?
    WHERE mac = ?
  `);
  const markQosFailed = db.prepare(`
    UPDATE device_auto_qos
    SET attempts = attempts + 1,
        last_error = ?,
        updated_at = ?
    WHERE mac = ?
  `);

  const markReserveApplied = supportsReserveCol
    ? db.prepare(`
        UPDATE device_auto_qos
        SET reserve_state = 'applied',
            reserved_ip = ?,
            reserve_attempts = reserve_attempts + 1,
            reserve_error = NULL,
            updated_at = ?
        WHERE mac = ?
      `)
    : null;
  const markReserveSkipped = supportsReserveCol
    ? db.prepare(`
        UPDATE device_auto_qos
        SET reserve_state = 'skipped',
            reserve_attempts = reserve_attempts + 1,
            reserve_error = ?,
            updated_at = ?
        WHERE mac = ?
      `)
    : null;
  const markReserveFailed = supportsReserveCol
    ? db.prepare(`
        UPDATE device_auto_qos
        SET reserve_attempts = reserve_attempts + 1,
            reserve_error = ?,
            updated_at = ?
        WHERE mac = ?
      `)
    : null;

  const hasQosCache = hasTable(db, 'router_qos_limits');
  const upsertQosCache = hasQosCache
    ? db.prepare(`
        INSERT INTO router_qos_limits (mac, router_id, ip, router_remark, online, download_limit_kbs, upload_limit_kbs, updated_at)
        VALUES (@mac, @router_id, NULL, @router_remark, @online, @download_limit_kbs, @upload_limit_kbs, @updated_at)
        ON CONFLICT(mac) DO UPDATE SET
          download_limit_kbs = excluded.download_limit_kbs,
          upload_limit_kbs = excluded.upload_limit_kbs,
          updated_at = excluded.updated_at
      `)
    : null;

  const hasDhcpCache = hasTable(db, 'dhcp_reservations');
  const upsertDhcpCache = hasDhcpCache
    ? db.prepare(`
        INSERT INTO dhcp_reservations (mac, ip, hostname, router_id, updated_at)
        VALUES (@mac, @ip, @hostname, @router_id, @updated_at)
        ON CONFLICT(mac) DO UPDATE SET
          ip = excluded.ip,
          hostname = COALESCE(excluded.hostname, dhcp_reservations.hostname),
          router_id = excluded.router_id,
          updated_at = excluded.updated_at
      `)
    : null;

  const hasSamples = hasTable(db, 'samples_raw');
  const hasDevices = hasTable(db, 'devices');

  for (const row of pending) {
    let appliedDl: number | null = null;
    let appliedUl: number | null = null;
    let appliedIp: string | null = null;

    if (row.state === 'pending' && row.attempts < 12) {
      try {
        const res = await router.setDeviceSpeedLimit({
          mac: row.mac,
          downloadLimitKBs: row.target_down_kbs,
          uploadLimitKBs: row.target_up_kbs,
        });
        if (res.ok && res.applied) {
          markQosApplied.run(now, now, row.mac);
          if (upsertQosCache) {
            upsertQosCache.run({
              mac: row.mac,
              router_id: res.applied.routerId,
              router_remark: res.applied.remark || null,
              online: 1,
              download_limit_kbs: res.applied.downloadLimitKBs,
              upload_limit_kbs: res.applied.uploadLimitKBs,
              updated_at: now,
            });
          }
          appliedDl = res.applied.downloadLimitKBs;
          appliedUl = res.applied.uploadLimitKBs;
        } else {
          markQosFailed.run(res.error ?? res.code ?? 'router rejected speed limit', now, row.mac);
        }
      } catch (err) {
        markQosFailed.run(String(err), now, row.mac);
      }
    }

    if (supportsReserveCol && row.reserve_state === 'pending' && row.reserve_attempts < 12) {
      if (!router.setDeviceDhcpReservation) {
        markReserveSkipped?.run('router DHCP reservation method unavailable', now, row.mac);
      } else {
        let candidateIp: string | null = null;
        if (hasQosCache) {
          const q = db.prepare(`SELECT ip FROM router_qos_limits WHERE mac = ?`).get(row.mac) as { ip: string | null } | undefined;
          if (q?.ip && isValidLanIpv4(q.ip)) candidateIp = q.ip.trim();
        }
        if (!candidateIp && hasSamples) {
          const s = db.prepare(`SELECT ip FROM samples_raw WHERE mac = ? AND ip IS NOT NULL ORDER BY ts DESC LIMIT 1`).get(row.mac) as { ip: string | null } | undefined;
          if (s?.ip && isValidLanIpv4(s.ip)) candidateIp = s.ip.trim();
        }

        let candidateLabel: string | null = null;
        if (hasDevices) {
          const d = db.prepare(`SELECT COALESCE(custom_label, router_remark, hostname) AS label FROM devices WHERE mac = ?`).get(row.mac) as { label: string | null } | undefined;
          candidateLabel = d?.label ?? null;
        }

        if (!candidateIp) {
          markReserveFailed?.run('waiting for valid LAN IPv4 address', now, row.mac);
        } else {
          try {
            const rsv = await router.setDeviceDhcpReservation({
              mac: row.mac,
              ip: candidateIp,
              remark: candidateLabel,
            });
            if (rsv.ok && rsv.applied) {
              markReserveApplied?.run(rsv.applied.ip, now, row.mac);
              if (upsertDhcpCache) {
                upsertDhcpCache.run({
                  mac: row.mac,
                  ip: rsv.applied.ip,
                  hostname: rsv.applied.remark || candidateLabel || null,
                  router_id: rsv.applied.routerId,
                  updated_at: now,
                });
              }
              appliedIp = rsv.applied.ip;
            } else if (rsv.code === 'IP_ALREADY_RESERVED' || rsv.code === 'AIC8800_FALLBACK_MAC') {
              markReserveSkipped?.run(rsv.error ?? rsv.code, now, row.mac);
            } else {
              markReserveFailed?.run(rsv.error ?? rsv.code ?? 'router rejected DHCP reservation', now, row.mac);
            }
          } catch (err) {
            markReserveFailed?.run(String(err), now, row.mac);
          }
        }
      }
    }

    if (appliedDl !== null || appliedUl !== null || appliedIp !== null) {
      applied.set(row.mac, {
        downloadLimitKBs: appliedDl,
        uploadLimitKBs: appliedUl,
        reservedIp: appliedIp,
      });
    }
  }

  return applied;
}

export function markDeviceAutoQosReviewed(db: Database.Database, mac: string, now = Date.now()): void {
  const macUp = mac.trim().toUpperCase();
  if (!macUp || !hasTable(db, 'device_auto_qos')) return;
  if (hasColumn(db, 'device_auto_qos', 'reserve_state')) {
    db.prepare(`
      UPDATE device_auto_qos
      SET state = CASE WHEN state IN ('pending', 'applied') THEN 'reviewed' ELSE state END,
          reserve_state = CASE WHEN reserve_state = 'pending' THEN 'reviewed' ELSE reserve_state END,
          reviewed_at = ?,
          updated_at = ?
      WHERE mac = ? AND (state IN ('pending', 'applied') OR reserve_state = 'pending')
    `).run(now, now, macUp);
    return;
  }
  db.prepare(`
    UPDATE device_auto_qos
    SET state = 'reviewed',
        reviewed_at = ?,
        updated_at = ?
    WHERE mac = ? AND state IN ('pending', 'applied')
  `).run(now, now, macUp);
}
