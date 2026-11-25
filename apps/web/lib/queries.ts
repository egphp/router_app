import 'server-only';
import os from 'node:os';
import net from 'node:net';
import { db } from './db';
import {
  bucket5Min,
  bucketHour,
  bucketDay,
  bucketMonth,
  HOUR,
  DAY,
  MIN,
  correlateDeviceWindowLanOrWan,
  isLocalInfraCategory,
} from '@tenda/shared';

const EXCLUDE_LOCAL_INFRA_SQL = `COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point') AND UPPER(d.mac) NOT LIKE '66:62:8B:%'`;

function isDeviceLocalInfra(mac: string, category: string | null | undefined): boolean {
  return isLocalInfraCategory(category) || mac.toUpperCase().startsWith('66:62:8B:');
}

function hasTable(conn: ReturnType<typeof db>, name: string): boolean {
  const row = conn
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

export interface DeviceRow {
  mac: string;
  hostname: string | null;
  router_remark: string | null;
  custom_label: string | null;
  vendor: string | null;
  category: string | null;
  ip: string | null;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  connect_type: number | null;
  connection_kind: 'wired' | 'wifi' | 'unknown' | null;
  wifi_band: '2.4GHz' | '5GHz' | 'wifi' | null;
  wifi_rssi_dbm: number | null;
  wifi_signal_percent: number | null;
  wifi_distance_m: number | null;
  wifi_distance_source: 'rssi-log-distance' | 'signal-percent-proxy' | null;
  bytes_today: number;
  bytes_up_today: number;
  bytes_total: number;
  bytes_up_total: number;
  is_new: 0 | 1;
  last_online_at: number | null;
  last_seen: number;
  first_seen: number;
  reserved: 0 | 1;
  reserved_ip: string | null;
  download_limit_kbs: number;
  upload_limit_kbs: number;
  qos_known: 0 | 1;
  wan_port: string | null;
  wan_group_name: string | null;
  wan_inherited_range: 0 | 1;
  auto_qos_state: 'pending' | 'applied' | 'reviewed' | 'skipped' | null;
  os_guess?: string | null;
  reverse_dns?: string | null;
  device_type?: string | null;
  ai_suggested_label?: string | null;
  ai_inferred_category?: string | null;
  ai_trust_tier?: string | null;
  ai_recommended_qos_profile?: string | null;
  ai_recommended_down_kbs?: number | null;
  ai_recommended_up_kbs?: number | null;
  ai_recommended_wan?: string | null;
  ai_randomized_match_mac?: string | null;
  ai_randomized_similarity?: number | null;
  ai_rationale_ar?: string | null;
}

export interface NetworkControlSummary {
  qos_policy: number;
  wan_route_policy: string;
  wan_ports: Array<{
    wan_id: number;
    wan_name: string;
    status: string;
    wan_type: string | null;
    wan_ip: string | null;
    wan_gateway: string | null;
    public_ip: string | null;
    public_ip_checked_at: number | null;
    public_ip_changed_at: number | null;
    ddns_fqdn: string | null;
    ddns_synced_ip: string | null;
    ddns_synced_at: number | null;
    ddns_last_error: string | null;
    up_flux_bps: number;
    down_flux_bps: number;
    pinned_device_count: number;
    updated_at: number;
  }>;
  limited_devices_count: number;
  pinned_devices_count: number;
  reserved_devices_count: number;
  auto_qos_policy: {
    enabled: boolean;
    auto_reserve: boolean;
    download_limit_kbs: number;
    upload_limit_kbs: number;
    quarantined_count: number;
  };
  ssh_access: {
    enabled: boolean;
    target_ip: string;
    external_port: number;
    ssh_user: string;
    wan1_active: boolean;
    wan2_active: boolean;
    wan2_internal_port: number | null;
  };
}

export interface RouterSnapshot {
  uptime_sec: number;
  online_count: number;
  total_devices: number;
  last_sample_ts: number | null;
  bytes_today_down: number;
  bytes_today_up: number;
  /** WAN flux observed from the router. Some Tenda firmware under-reports this, so it is diagnostic only. */
  wan_today_down: number;
  wan_today_up: number;
  wan_first_sample_ts: number | null;
  wan_today_complete: boolean;
  top_device: { mac: string; label: string; bytes_down: number; bytes_up: number } | null;
  top_device_2: { mac: string; label: string; bytes_down: number; bytes_up: number } | null;
  alerts_undismissed: number;
}

export function getLatestDevices(): DeviceRow[] {
  const conn = db();
  const startOfDay = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();

  const todayBytes = bytesSinceSql(startOfDay);
  const allBytes = bytesSinceSql(0);

  const rows = conn.prepare(`
    WITH latest AS (
      SELECT mac, MAX(ts) AS ts FROM samples_raw GROUP BY mac
    ),
    last_online AS (
      SELECT mac, MAX(ts) AS last_online_at
      FROM samples_raw
      WHERE online = 1
      GROUP BY mac
    ),
    today AS (${todayBytes.sql}),
    alltime AS (${allBytes.sql}),
    sessions AS (
      SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
      FROM device_sessions
      GROUP BY mac
    )
    SELECT d.mac, d.hostname, d.router_remark, d.custom_label, d.vendor, d.category,
           d.is_new, d.last_seen, d.first_seen,
           lo.last_online_at,
           s.ip, s.online, s.up_speed_bps, s.down_speed_bps,
           s.connect_type, s.connection_kind, s.wifi_band, s.wifi_rssi_dbm, s.wifi_signal_percent,
           s.wifi_distance_m, s.wifi_distance_source,
           COALESCE(td.bd, 0) AS bytes_today,
           COALESCE(td.bu, 0) AS bytes_up_today,
           CASE WHEN at.mac IS NOT NULL THEN COALESCE(at.bd, 0) ELSE COALESCE(ses.bd, 0) END AS bytes_total,
           CASE WHEN at.mac IS NOT NULL THEN COALESCE(at.bu, 0) ELSE COALESCE(ses.bu, 0) END AS bytes_up_total,
           CASE WHEN res.mac IS NOT NULL THEN 1 ELSE 0 END AS reserved,
           res.ip AS reserved_ip,
           COALESCE(ql.download_limit_kbs, 0) AS download_limit_kbs,
           COALESCE(ql.upload_limit_kbs, 0) AS upload_limit_kbs,
           CASE WHEN ql.mac IS NOT NULL THEN 1 ELSE 0 END AS qos_known,
           wb.wan_port AS wan_port,
           wb.ip_group_name AS wan_group_name,
           COALESCE(wb.inherited_from_range, 0) AS wan_inherited_range,
           aq.state AS auto_qos_state
    FROM devices d
    LEFT JOIN latest l ON l.mac = d.mac
    LEFT JOIN samples_raw s ON s.mac = d.mac AND s.ts = l.ts
    LEFT JOIN last_online lo ON lo.mac = d.mac
    LEFT JOIN today td ON td.mac = d.mac
    LEFT JOIN alltime at ON at.mac = d.mac
    LEFT JOIN sessions ses ON ses.mac = d.mac
    LEFT JOIN dhcp_reservations res ON res.mac = d.mac
    LEFT JOIN router_qos_limits ql ON ql.mac = d.mac
    LEFT JOIN router_wan_bindings wb ON wb.ip = COALESCE(s.ip, res.ip) AND wb.rule_enabled = 1
    LEFT JOIN device_auto_qos aq ON aq.mac = d.mac
    ORDER BY bytes_today DESC, d.last_seen DESC
  `).all(...todayBytes.params, ...allBytes.params) as DeviceRow[];
  const enrichmentMap = new Map<string, { os_guess: string | null; reverse_dns: string | null; device_type: string | null }>();
  if (hasTable(conn, 'device_enrichment')) {
    const enrRows = conn
      .prepare(`SELECT mac, os_guess, reverse_dns, device_type FROM device_enrichment`)
      .all() as Array<{ mac: string; os_guess: string | null; reverse_dns: string | null; device_type: string | null }>;
    for (const e of enrRows) enrichmentMap.set(e.mac, e);
  }

  const aiProfileMap = new Map<
    string,
    {
      suggested_label: string | null;
      inferred_category: string | null;
      trust_tier: string | null;
      recommended_qos_profile: string | null;
      recommended_down_kbs: number | null;
      recommended_up_kbs: number | null;
      recommended_wan: string | null;
      randomized_match_mac: string | null;
      randomized_similarity: number | null;
      rationale_ar: string | null;
    }
  >();
  if (hasTable(conn, 'ai_device_profiles')) {
    const aiRows = conn
      .prepare(
        `SELECT mac, suggested_label, inferred_category, trust_tier, recommended_qos_profile,
                recommended_down_kbs, recommended_up_kbs, recommended_wan,
                randomized_match_mac, randomized_similarity, rationale_ar
         FROM ai_device_profiles`,
      )
      .all() as Array<{
      mac: string;
      suggested_label: string | null;
      inferred_category: string | null;
      trust_tier: string | null;
      recommended_qos_profile: string | null;
      recommended_down_kbs: number | null;
      recommended_up_kbs: number | null;
      recommended_wan: string | null;
      randomized_match_mac: string | null;
      randomized_similarity: number | null;
      rationale_ar: string | null;
    }>;
    for (const a of aiRows) aiProfileMap.set(a.mac, a);
  }

  return rows.map((r) => {
    const enr = enrichmentMap.get(r.mac);
    const ai = aiProfileMap.get(r.mac);
    return {
      ...r,
      online: (r.online ?? 0) as 0 | 1,
      last_online_at: r.last_online_at === null || r.last_online_at === undefined ? null : Number(r.last_online_at),
      up_speed_bps: r.up_speed_bps ?? 0,
      down_speed_bps: r.down_speed_bps ?? 0,
      connect_type: r.connect_type ?? null,
      connection_kind: r.connection_kind ?? null,
      wifi_band: r.wifi_band ?? null,
      wifi_rssi_dbm: r.wifi_rssi_dbm === null || r.wifi_rssi_dbm === undefined ? null : Number(r.wifi_rssi_dbm),
      wifi_signal_percent: r.wifi_signal_percent === null || r.wifi_signal_percent === undefined ? null : Number(r.wifi_signal_percent),
      wifi_distance_m: r.wifi_distance_m === null || r.wifi_distance_m === undefined ? null : Number(r.wifi_distance_m),
      wifi_distance_source: r.wifi_distance_source ?? null,
      bytes_today: Number(r.bytes_today ?? 0),
      bytes_up_today: Number(r.bytes_up_today ?? 0),
      bytes_total: Number(r.bytes_total ?? 0),
      bytes_up_total: Number(r.bytes_up_total ?? 0),
      reserved: (r.reserved ?? 0) as 0 | 1,
      reserved_ip: r.reserved_ip ?? null,
      download_limit_kbs: Number(r.download_limit_kbs ?? 0),
      upload_limit_kbs: Number(r.upload_limit_kbs ?? 0),
      qos_known: (r.qos_known ?? 0) as 0 | 1,
      wan_port: r.wan_port ?? null,
      wan_group_name: r.wan_group_name ?? null,
      wan_inherited_range: (r.wan_inherited_range ?? 0) as 0 | 1,
      auto_qos_state: (r.auto_qos_state as DeviceRow['auto_qos_state']) ?? null,
      os_guess: enr?.os_guess ?? null,
      reverse_dns: enr?.reverse_dns ?? null,
      device_type: enr?.device_type ?? null,
      ai_suggested_label: ai?.suggested_label ?? null,
      ai_inferred_category: ai?.inferred_category ?? null,
      ai_trust_tier: ai?.trust_tier ?? null,
      ai_recommended_qos_profile: ai?.recommended_qos_profile ?? null,
      ai_recommended_down_kbs: ai?.recommended_down_kbs ?? null,
      ai_recommended_up_kbs: ai?.recommended_up_kbs ?? null,
      ai_recommended_wan: ai?.recommended_wan ?? null,
      ai_randomized_match_mac: ai?.randomized_match_mac ?? null,
      ai_randomized_similarity: ai?.randomized_similarity ?? null,
      ai_rationale_ar: ai?.rationale_ar ?? null,
    };
  });
}

function detectDefaultLanIp(): string {
  const routerHost = (process.env.ROUTER_HOST ?? '').trim();
  const prefix = net.isIPv4(routerHost) ? routerHost.split('.').slice(0, 3).join('.') + '.' : null;
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.internal || addr.family !== 'IPv4') continue;
      if (addr.netmask === '255.255.255.255' || addr.address.endsWith('.241') || addr.address.endsWith('.242')) continue;
      const [a, b] = addr.address.split('.').map(Number);
      const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b !== undefined && b >= 16 && b <= 31);
      if (!isPrivate) continue;
      if (prefix && addr.address.startsWith(prefix)) return addr.address;
      candidates.push(addr.address);
    }
  }
  return candidates[0] ?? '';
}

function detectDefaultSshUser(): string {
  try {
    const u = os.userInfo().username.trim();
    if (/^[a-zA-Z0-9._-]{1,64}$/.test(u)) return u;
  } catch {
    // ignore
  }
  return 'admin';
}

export function getNetworkControlSummary(): NetworkControlSummary {
  const conn = db();
  const kvRows = conn.prepare(`
    SELECT key, value FROM kv
    WHERE key IN (
      'router.qos_policy',
      'router.wan_route_policy',
      'router.auto_qos_new_devices.enabled',
      'router.auto_qos_new_devices.auto_reserve',
      'router.auto_qos_new_devices.download_kbs',
      'router.auto_qos_new_devices.upload_kbs',
      'router.ssh_access.enabled',
      'router.ssh_access.target_ip',
      'router.ssh_access.external_port',
      'router.ssh_access.ssh_user'
    )
  `).all() as Array<{ key: string; value: string }>;
  const kvMap = new Map(kvRows.map((r) => [r.key, r.value]));

  const ports = conn.prepare(`
    SELECT p.wan_id, p.wan_name, p.status, p.wan_type, p.wan_ip, p.wan_gateway,
           p.public_ip, p.public_ip_checked_at, p.public_ip_changed_at,
           p.ddns_fqdn, p.ddns_synced_ip, p.ddns_synced_at, p.ddns_last_error,
           p.up_flux_bps, p.down_flux_bps, p.updated_at,
           (
             SELECT COUNT(*) FROM router_wan_bindings wb
             WHERE wb.wan_port = p.wan_name AND wb.rule_enabled = 1 AND wb.inherited_from_range = 0 AND LOWER(COALESCE(wb.ip_group_name, '')) NOT IN ('ssh_wan1', 'ssh_wan2')
           ) AS pinned_device_count
    FROM router_wan_ports p
    ORDER BY p.wan_id ASC
  `).all() as NetworkControlSummary['wan_ports'];

  const counts = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM router_qos_limits WHERE download_limit_kbs > 0 OR upload_limit_kbs > 0) AS limited_count,
      (SELECT COUNT(*) FROM router_wan_bindings WHERE rule_enabled = 1 AND inherited_from_range = 0 AND LOWER(COALESCE(ip_group_name, '')) NOT IN ('ssh_wan1', 'ssh_wan2')) AS pinned_count,
      (SELECT COUNT(*) FROM dhcp_reservations) AS reserved_count,
      (SELECT COUNT(*) FROM device_auto_qos WHERE state IN ('pending', 'applied')) AS quarantined_count
  `).get() as { limited_count: number; pinned_count: number; reserved_count: number; quarantined_count: number };

  const rawAutoEn = kvMap.get('router.auto_qos_new_devices.enabled');
  const autoEnabled = rawAutoEn === undefined ? true : rawAutoEn !== '0' && rawAutoEn !== 'false';
  const rawAutoRes = kvMap.get('router.auto_qos_new_devices.auto_reserve');
  const autoReserve = rawAutoRes === undefined ? true : rawAutoRes !== '0' && rawAutoRes !== 'false';
  const rawAutoDl = kvMap.get('router.auto_qos_new_devices.download_kbs');
  const autoDl = rawAutoDl === undefined ? 256 : Math.max(0, Math.round(Number(rawAutoDl) || 0));
  const rawAutoUl = kvMap.get('router.auto_qos_new_devices.upload_kbs');
  const autoUl = rawAutoUl === undefined ? 64 : Math.max(0, Math.round(Number(rawAutoUl) || 0));

  const rawSshEn = kvMap.get('router.ssh_access.enabled');
  const sshEnabled = rawSshEn === '1' || rawSshEn === 'true';
  const rawSshIp = (kvMap.get('router.ssh_access.target_ip') ?? '').trim();
  const sshTargetIp = net.isIPv4(rawSshIp) ? rawSshIp : detectDefaultLanIp();
  const rawSshPort = Number(kvMap.get('router.ssh_access.external_port'));
  const sshExternalPort =
    Number.isInteger(rawSshPort) && (rawSshPort === 22 || (rawSshPort >= 1024 && rawSshPort <= 65535))
      ? rawSshPort
      : 22222;
  const rawSshUser = (kvMap.get('router.ssh_access.ssh_user') ?? '').trim();
  const sshUser = /^[a-zA-Z0-9._-]{1,64}$/.test(rawSshUser) ? rawSshUser : detectDefaultSshUser();

  let wan1Active = false;
  let wan2Active = false;
  let wan2InternalPort: number | null = null;
  try {
    if (sshTargetIp) {
      const sshPrefix = sshTargetIp.split('.').slice(0, 3).join('.');
      const wan1Vip = `${sshPrefix}.241`;
      const wan2Vip = `${sshPrefix}.242`;
      const pmRows = conn.prepare(`
        SELECT wan_id, internal_port, external_port, enabled
        FROM router_port_mappings
        WHERE server_ip IN (?, ?, ?) AND external_port = ? AND enabled = 1
      `).all(sshTargetIp, wan1Vip, wan2Vip, sshExternalPort) as Array<{
        wan_id: number;
        internal_port: number;
        external_port: number;
        enabled: number;
      }>;
      for (const pm of pmRows) {
        if (Number(pm.wan_id) === 1) wan1Active = true;
        if (Number(pm.wan_id) === 2) {
          wan2Active = true;
          wan2InternalPort = Number(pm.internal_port);
        }
      }
    }
  } catch {
    // Table may not exist yet before migration 025 runs
  }

  return {
    qos_policy: Number(kvMap.get('router.qos_policy') ?? 2),
    wan_route_policy: kvMap.get('router.wan_route_policy') ?? 'custom',
    wan_ports: ports.map((p) => ({
      ...p,
      wan_id: Number(p.wan_id),
      public_ip: p.public_ip ?? null,
      public_ip_checked_at:
        p.public_ip_checked_at === null || p.public_ip_checked_at === undefined
          ? null
          : Number(p.public_ip_checked_at),
      public_ip_changed_at:
        p.public_ip_changed_at === null || p.public_ip_changed_at === undefined
          ? null
          : Number(p.public_ip_changed_at),
      ddns_fqdn: p.ddns_fqdn ?? null,
      ddns_synced_ip: p.ddns_synced_ip ?? null,
      ddns_synced_at:
        p.ddns_synced_at === null || p.ddns_synced_at === undefined
          ? null
          : Number(p.ddns_synced_at),
      ddns_last_error: p.ddns_last_error ?? null,
      up_flux_bps: Number(p.up_flux_bps ?? 0),
      down_flux_bps: Number(p.down_flux_bps ?? 0),
      pinned_device_count: Number(p.pinned_device_count ?? 0),
      updated_at: Number(p.updated_at ?? 0),
    })),
    limited_devices_count: Number(counts?.limited_count ?? 0),
    pinned_devices_count: Number(counts?.pinned_count ?? 0),
    reserved_devices_count: Number(counts?.reserved_count ?? 0),
    auto_qos_policy: {
      enabled: autoEnabled,
      auto_reserve: autoReserve,
      download_limit_kbs: autoDl,
      upload_limit_kbs: autoUl,
      quarantined_count: Number(counts?.quarantined_count ?? 0),
    },
    ssh_access: {
      enabled: sshEnabled,
      target_ip: sshTargetIp,
      external_port: sshExternalPort,
      ssh_user: sshUser,
      wan1_active: wan1Active,
      wan2_active: wan2Active,
      wan2_internal_port: wan2InternalPort,
    },
  };
}

export function getRouterSnapshot(): RouterSnapshot {
  const conn = db();
  const latest = conn.prepare(`SELECT * FROM router_state ORDER BY ts DESC LIMIT 1`).get() as
    | { ts: number; uptime_sec: number; online_count: number | null }
    | undefined;

  const startOfDay = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  const t5Totals = conn.prepare(`
    SELECT COALESCE(SUM(t.bytes_down), 0) AS bd, COALESCE(SUM(t.bytes_up), 0) AS bu
    FROM traffic_5min t
    LEFT JOIN devices d ON d.mac = t.mac
    WHERE t.bucket_ts >= ?
      AND COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point')
      AND UPPER(t.mac) NOT LIKE '66:62:8B:%'
  `).get(startOfDay) as { bd: number; bu: number };
  const thTotals = conn.prepare(`
    SELECT COALESCE(SUM(t.bytes_down), 0) AS bd, COALESCE(SUM(t.bytes_up), 0) AS bu
    FROM traffic_hour t
    LEFT JOIN devices d ON d.mac = t.mac
    WHERE t.bucket_ts >= ?
      AND COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point')
      AND UPPER(t.mac) NOT LIKE '66:62:8B:%'
  `).get(startOfDay) as { bd: number; bu: number };
  const todayTotals = {
    bytes_down: Number(t5Totals.bd) + Number(thTotals.bd),
    bytes_up: Number(t5Totals.bu) + Number(thTotals.bu),
  };

  const topToday = conn.prepare(`
    SELECT u.mac, SUM(u.bytes_down) AS bd, SUM(u.bytes_up) AS bu
    FROM (
      SELECT mac, bytes_down, bytes_up FROM traffic_5min WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ?
    ) u
    LEFT JOIN devices d ON d.mac = u.mac
    WHERE COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point')
      AND UPPER(u.mac) NOT LIKE '66:62:8B:%'
    GROUP BY u.mac
    ORDER BY (bd + bu) DESC
    LIMIT 2
  `).all(startOfDay, startOfDay) as Array<{ mac: string; bd: number; bu: number }>;

  let topDevice = null as RouterSnapshot['top_device'];
  let topDevice2 = null as RouterSnapshot['top_device'];
  if (topToday[0]) {
    const d = conn.prepare(`SELECT mac, COALESCE(custom_label, hostname, mac) AS label FROM devices WHERE mac = ?`).get(topToday[0].mac) as { mac: string; label: string };
    topDevice = { mac: d.mac, label: d.label, bytes_down: Number(topToday[0].bd ?? 0), bytes_up: Number(topToday[0].bu ?? 0) };
  }
  if (topToday[1]) {
    const d = conn.prepare(`SELECT mac, COALESCE(custom_label, hostname, mac) AS label FROM devices WHERE mac = ?`).get(topToday[1].mac) as { mac: string; label: string };
    topDevice2 = { mac: d.mac, label: d.label, bytes_down: Number(topToday[1].bd ?? 0), bytes_up: Number(topToday[1].bu ?? 0) };
  }

  const counts = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices) AS total,
      (SELECT COUNT(*) FROM alerts WHERE dismissed_at IS NULL) AS alerts
  `).get() as { total: number; alerts: number };

  // WAN-level cumulative today (ground truth, independent of per-device estimates).
  const wanRow = conn.prepare(`
    SELECT COALESCE(SUM(bytes_down), 0) AS bd, COALESCE(SUM(bytes_up), 0) AS bu
    FROM wan_traffic_day WHERE bucket_ts >= ?
  `).get(startOfDay) as { bd: number; bu: number } | undefined;
  const wanCoverage = conn.prepare(`
    SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS sample_count
    FROM wan_samples WHERE ts >= ?
  `).get(startOfDay) as { first_ts: number | null; last_ts: number | null; sample_count: number };
  const wanTodayComplete = Boolean(
    Number(wanCoverage.sample_count ?? 0) > 0 &&
    Number(wanCoverage.first_ts ?? Number.POSITIVE_INFINITY) <= startOfDay + 2 * MIN
  );

  return {
    uptime_sec: latest?.uptime_sec ?? 0,
    online_count: latest?.online_count ?? 0,
    total_devices: counts.total,
    last_sample_ts: latest?.ts ?? null,
    bytes_today_down: Number(todayTotals.bytes_down ?? 0),
    bytes_today_up: Number(todayTotals.bytes_up ?? 0),
    wan_today_down: Number(wanRow?.bd ?? 0),
    wan_today_up: Number(wanRow?.bu ?? 0),
    wan_first_sample_ts: wanCoverage.first_ts ?? null,
    wan_today_complete: wanTodayComplete,
    top_device: topDevice,
    top_device_2: topDevice2,
    alerts_undismissed: counts.alerts,
  };
}

export interface LiveSpeedPoint { ts: number; down_bps: number; up_bps: number }

export interface LiveSpeedSeries {
  speeds: LiveSpeedPoint[];
  source: 'router-best' | 'router-direct' | 'wan' | 'devices';
  latest_ts: number | null;
}

function getDeviceRecentSpeeds(conn: ReturnType<typeof db>, since: number): LiveSpeedPoint[] {
  return conn.prepare(`
    SELECT s.ts, SUM(s.down_speed_bps) AS down_bps, SUM(s.up_speed_bps) AS up_bps
    FROM samples_raw s
    LEFT JOIN devices d ON d.mac = s.mac
    WHERE s.ts >= ?
      AND COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point')
      AND UPPER(s.mac) NOT LIKE '66:62:8B:%'
    GROUP BY s.ts
    ORDER BY s.ts ASC
  `).all(since) as LiveSpeedPoint[];
}

function getDeviceCounterRecentSpeeds(conn: ReturnType<typeof db>, since: number): LiveSpeedPoint[] {
  return conn.prepare(`
    WITH recent AS (
      SELECT
        s.mac,
        s.ts,
        s.down_sum_kb,
        s.up_speed_bps,
        LAG(s.ts) OVER (PARTITION BY s.mac ORDER BY s.ts) AS prev_ts,
        LAG(s.down_sum_kb) OVER (PARTITION BY s.mac ORDER BY s.ts) AS prev_down_sum_kb
      FROM samples_raw s
      LEFT JOIN devices d ON d.mac = s.mac
      WHERE s.ts >= ?
        AND COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point')
        AND UPPER(s.mac) NOT LIKE '66:62:8B:%'
    )
    SELECT
      ts,
      SUM(
        CASE
          WHEN prev_ts IS NULL THEN 0
          WHEN ts < ? THEN 0
          WHEN ts <= prev_ts THEN 0
          WHEN ts - prev_ts > ? THEN 0
          WHEN down_sum_kb IN (2097151, 4194303) OR prev_down_sum_kb IN (2097151, 4194303) THEN 0
          WHEN down_sum_kb < prev_down_sum_kb THEN 0
          ELSE ((down_sum_kb - prev_down_sum_kb) * 1024.0 * 1000.0) / (ts - prev_ts)
        END
      ) AS down_bps,
      SUM(up_speed_bps) AS up_bps
    FROM recent
    WHERE ts >= ?
    GROUP BY ts
    ORDER BY ts ASC
  `).all(since - 5 * MIN, since, 5 * MIN, since) as LiveSpeedPoint[];
}

function chooseBestSpeedSeries(
  wanRows: LiveSpeedPoint[],
  deviceRows: LiveSpeedPoint[],
  counterRows: LiveSpeedPoint[],
): LiveSpeedPoint[] {
  const byTs = new Map<number, LiveSpeedPoint>();
  const merge = (rows: LiveSpeedPoint[]) => {
    for (const row of rows) {
      const current = byTs.get(row.ts) ?? { ts: row.ts, down_bps: 0, up_bps: 0 };
      current.down_bps = Math.max(Number(current.down_bps ?? 0), Number(row.down_bps ?? 0));
      current.up_bps = Math.max(Number(current.up_bps ?? 0), Number(row.up_bps ?? 0));
      byTs.set(row.ts, current);
    }
  };
  merge(wanRows);
  merge(deviceRows);
  merge(counterRows);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function getRecentSpeedSeries(minutes = 60): LiveSpeedSeries {
  const conn = db();
  const since = Date.now() - minutes * MIN;
  const wanRows = conn.prepare(`
    SELECT ts, SUM(down_bytes_per_s) AS down_bps, SUM(up_bytes_per_s) AS up_bps
    FROM wan_samples
    WHERE ts >= ?
    GROUP BY ts
    ORDER BY ts ASC
  `).all(since) as LiveSpeedPoint[];

  const hasActiveWan = wanRows.some((r) => Number(r.down_bps ?? 0) > 0 || Number(r.up_bps ?? 0) > 0);
  if (wanRows.length > 0 && hasActiveWan) {
    return {
      speeds: wanRows.map((r) => ({
        ts: Number(r.ts),
        down_bps: Number(r.down_bps ?? 0),
        up_bps: Number(r.up_bps ?? 0),
      })),
      source: 'wan',
      latest_ts: wanRows[wanRows.length - 1]?.ts ?? null,
    };
  }

  const deviceRows = getDeviceRecentSpeeds(conn, since);
  const counterRows = getDeviceCounterRecentSpeeds(conn, since);
  const bestRows = chooseBestSpeedSeries(wanRows, deviceRows, counterRows);

  if (bestRows.length > 0) {
    return {
      speeds: bestRows,
      source: 'router-best',
      latest_ts: bestRows[bestRows.length - 1]?.ts ?? null,
    };
  }

  return {
    speeds: deviceRows,
    source: 'devices',
    latest_ts: deviceRows[deviceRows.length - 1]?.ts ?? null,
  };
}

export function getRecentSpeeds(minutes = 60): LiveSpeedPoint[] {
  return getRecentSpeedSeries(minutes).speeds;
}

export function getRecentDeviceSpeeds(minutes = 60): LiveSpeedPoint[] {
  const conn = db();
  return getDeviceRecentSpeeds(conn, Date.now() - minutes * MIN);
}

export type Bucket = 'hour' | 'today' | 'week' | 'month' | 'year' | 'all';

export interface BucketPoint { bucket_ts: number; bytes_down: number; bytes_up: number; peak_down_bps?: number; peak_up_bps?: number }

export function getDeviceTraffic(mac: string, range: Bucket): BucketPoint[] {
  const conn = db();
  const now = Date.now();
  switch (range) {
    case 'hour': {
      const since = now - HOUR;
      const startOfHour = (() => { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); })();
      const rows = conn.prepare(`
        SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
        FROM traffic_5min WHERE mac = ? AND bucket_ts >= ?
        UNION ALL
        SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
        FROM traffic_hour WHERE mac = ? AND bucket_ts >= ? AND bucket_ts < ?
        ORDER BY bucket_ts ASC
      `).all(mac, since, mac, bucketHour(since), startOfHour) as BucketPoint[];
      return rows;
    }
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      const since = d.getTime();
      const frag = trafficRowsSinceSql(since, mac);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, (ts) => bucketHour(ts));
    }
    case 'week': {
      const d = new Date(now);
      const since = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime();
      const frag = trafficRowsSinceSql(since, mac, false);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketLocalDay);
    }
    case 'month': {
      const d = new Date(now);
      const since = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29).getTime();
      const frag = trafficRowsSinceSql(since, mac, false);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketLocalDay);
    }
    case 'year': {
      const d = new Date(now);
      const since = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()).getTime();
      const frag = trafficRowsSinceSql(since, mac, true);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketMonth);
    }
    case 'all': {
      const frag = trafficRowsSinceSql(0, mac, true);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketMonth);
    }
  }
}

export function getDeviceTrafficForDay(mac: string, dayStart: number): BucketPoint[] {
  const dayEnd = dayStart + DAY;
  const now = Date.now();
  const startOfHour = (() => { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); })();
  const parts: string[] = [];
  const params: unknown[] = [];

  const completedHourEnd = Math.min(dayEnd, startOfHour);
  if (completedHourEnd > dayStart) {
    parts.push(`
      SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
      FROM traffic_hour
      WHERE mac = ? AND bucket_ts >= ? AND bucket_ts < ?
    `);
    params.push(mac, dayStart, completedHourEnd);
  }

  const liveStart = Math.max(dayStart, startOfHour);
  if (dayEnd > liveStart && now >= liveStart) {
    parts.push(`
      SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
      FROM traffic_5min
      WHERE mac = ? AND bucket_ts >= ? AND bucket_ts < ?
    `);
    params.push(mac, liveStart, dayEnd);
  }

  if (parts.length === 0) return [];
  const rows = db().prepare(parts.join(' UNION ALL ')).all(...params) as BucketPoint[];
  return aggregateRows(rows, bucketHour);
}

function bucketLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function aggregateRows(rows: BucketPoint[], bucketFn: (ts: number) => number): BucketPoint[] {
  const map = new Map<number, BucketPoint>();
  for (const r of rows) {
    const bucket = bucketFn(r.bucket_ts);
    const current = map.get(bucket) ?? { bucket_ts: bucket, bytes_down: 0, bytes_up: 0, peak_down_bps: 0, peak_up_bps: 0 };
    current.bytes_down += Number(r.bytes_down ?? 0);
    current.bytes_up += Number(r.bytes_up ?? 0);
    current.peak_down_bps = Math.max(Number(current.peak_down_bps ?? 0), Number(r.peak_down_bps ?? 0));
    current.peak_up_bps = Math.max(Number(current.peak_up_bps ?? 0), Number(r.peak_up_bps ?? 0));
    map.set(bucket, current);
  }
  return [...map.values()].sort((a, b) => a.bucket_ts - b.bucket_ts);
}

export function getAlerts(limit = 50) {
  return db().prepare(`
    SELECT a.id, a.kind, a.mac, a.payload, a.created_at, a.dismissed_at,
           COALESCE(d.custom_label, d.hostname, a.mac) AS device_label
    FROM alerts a LEFT JOIN devices d ON d.mac = a.mac
    ORDER BY a.created_at DESC LIMIT ?
  `).all(limit);
}

export function getOutages(limit = 100) {
  return db().prepare(`SELECT * FROM outages ORDER BY started_at DESC LIMIT ?`).all(limit);
}

export function dismissAlert(id: number) {
  return db().prepare(`UPDATE alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`).run(Date.now(), id);
}

export function dismissAllAlerts() {
  return db().prepare(`UPDATE alerts SET dismissed_at = ? WHERE dismissed_at IS NULL`).run(Date.now());
}

export function markAllDevicesKnown() {
  return db().prepare(`UPDATE devices SET is_new = 0, updated_at = ? WHERE is_new = 1`).run(Date.now());
}

export function dismissAlertsByKind(kind: string) {
  return db().prepare(`UPDATE alerts SET dismissed_at = ? WHERE dismissed_at IS NULL AND kind = ?`).run(Date.now(), kind);
}

export function updateDevice(mac: string, fields: { custom_label?: string | null; category?: string | null; notes?: string | null; is_new?: 0 | 1 }) {
  const setClauses: string[] = [];
  const values: Record<string, unknown> = { mac, now: Date.now() };
  if (fields.custom_label !== undefined) { setClauses.push('custom_label = @custom_label'); values.custom_label = fields.custom_label; }
  if (fields.category !== undefined) { setClauses.push('category = @category'); values.category = fields.category; }
  if (fields.notes !== undefined) { setClauses.push('notes = @notes'); values.notes = fields.notes; }
  if (fields.is_new !== undefined) { setClauses.push('is_new = @is_new'); values.is_new = fields.is_new; }
  if (setClauses.length === 0) return;
  db().prepare(`UPDATE devices SET ${setClauses.join(', ')}, updated_at = @now WHERE mac = @mac`).run(values);
}

export interface DeleteDeviceResult {
  existed: boolean;
  changes: Record<string, number>;
}

export function deleteDevice(mac: string): DeleteDeviceResult {
  const conn = db();
  const macUp = mac.toUpperCase();
  const deleteByMac = [
    ['samples_raw', 'mac'],
    ['traffic_5min', 'mac'],
    ['traffic_hour', 'mac'],
    ['traffic_day', 'mac'],
    ['traffic_month', 'mac'],
    ['device_sessions', 'mac'],
    ['device_quotas', 'mac'],
    ['device_enrichment', 'mac'],
    ['router_qos_limits', 'mac'],
    ['device_auto_qos', 'mac'],
    ['alerts', 'mac'],
    ['router_syslog', 'attacker_mac'],
    ['nsfw_hits', 'source_mac'],
    ['nsfw_push_events', 'source_mac'],
    ['device_notification_thresholds', 'mac'],
    ['notification_suppressions', 'mac'],
    ['devices', 'mac'],
  ] as const;

  return conn.transaction(() => {
    const existing = conn.prepare(`SELECT mac FROM devices WHERE mac = ?`).get(macUp) as { mac: string } | undefined;
    if (!existing) return { existed: false, changes: {} };

    const changes: Record<string, number> = {};
    for (const [table, column] of deleteByMac) {
      changes[table] = deleteWhereIfColumnExists(conn, table, column, macUp);
    }
    changes.router_log = deleteWhereTextContainsIfColumnExists(conn, 'router_log', 'message', macUp);
    changes.notification_state = deleteWhereTextContainsIfColumnExists(conn, 'notification_state', 'state_key', macUp);
    return { existed: true, changes };
  })();
}

const SAFE_SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function assertSafeSqlIdent(ident: string): void {
  if (!SAFE_SQL_IDENT_RE.test(ident)) {
    throw new Error(`Unsafe SQL identifier blocked: ${ident}`);
  }
}

function deleteWhereIfColumnExists(conn: ReturnType<typeof db>, table: string, column: string, value: string): number {
  assertSafeSqlIdent(table);
  assertSafeSqlIdent(column);
  const tableRow = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { name: string } | undefined;
  if (!tableRow) return 0;
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) return 0;
  return Number(conn.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value).changes ?? 0);
}

function deleteWhereTextContainsIfColumnExists(conn: ReturnType<typeof db>, table: string, column: string, value: string): number {
  assertSafeSqlIdent(table);
  assertSafeSqlIdent(column);
  const tableRow = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { name: string } | undefined;
  if (!tableRow) return 0;
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) return 0;
  return Number(conn.prepare(`DELETE FROM ${table} WHERE ${column} LIKE ?`).run(`%${value}%`).changes ?? 0);
}

export function getDevice(mac: string) {
  const conn = db();
  const base = conn.prepare(`
    SELECT d.*,
           (SELECT MAX(ts) FROM samples_raw sr_online WHERE sr_online.mac = d.mac AND sr_online.online = 1) AS last_online_at,
           s.ip, s.online, s.connect_type, s.connection_kind, s.wifi_band, s.wifi_rssi_dbm,
           s.wifi_signal_percent, s.wifi_distance_m, s.wifi_distance_source,
           COALESCE(s.up_speed_bps, 0) AS up_speed_bps,
           COALESCE(s.down_speed_bps, 0) AS down_speed_bps,
           CASE WHEN res.mac IS NOT NULL THEN 1 ELSE 0 END AS reserved,
           res.ip AS reserved_ip,
           COALESCE(ql.download_limit_kbs, 0) AS download_limit_kbs,
           COALESCE(ql.upload_limit_kbs, 0) AS upload_limit_kbs,
           CASE WHEN ql.mac IS NOT NULL THEN 1 ELSE 0 END AS qos_known,
           wb.wan_port AS wan_port,
           wb.ip_group_name AS wan_group_name,
           COALESCE(wb.inherited_from_range, 0) AS wan_inherited_range,
           aq.state AS auto_qos_state
    FROM devices d
    LEFT JOIN (
      SELECT *
      FROM samples_raw
      WHERE mac = ?
      ORDER BY ts DESC
      LIMIT 1
    ) s ON s.mac = d.mac
    LEFT JOIN dhcp_reservations res ON res.mac = d.mac
    LEFT JOIN router_qos_limits ql ON ql.mac = d.mac
    LEFT JOIN router_wan_bindings wb ON wb.ip = COALESCE(s.ip, res.ip) AND wb.rule_enabled = 1
    LEFT JOIN device_auto_qos aq ON aq.mac = d.mac
    WHERE d.mac = ?
  `).get(mac, mac) as Record<string, unknown> | undefined;
  if (!base) return undefined;

  const enr = hasTable(conn, 'device_enrichment')
    ? (conn
        .prepare(`SELECT os_guess, reverse_dns, device_type FROM device_enrichment WHERE mac = ?`)
        .get(mac) as { os_guess?: string | null; reverse_dns?: string | null; device_type?: string | null } | undefined)
    : undefined;
  const ai = hasTable(conn, 'ai_device_profiles')
    ? (conn
        .prepare(
          `SELECT suggested_label, inferred_category, trust_tier, recommended_qos_profile,
                  recommended_down_kbs, recommended_up_kbs, recommended_wan,
                  randomized_match_mac, randomized_similarity, rationale_ar
           FROM ai_device_profiles WHERE mac = ?`,
        )
        .get(mac) as Record<string, unknown> | undefined)
    : undefined;

  return {
    ...base,
    os_guess: enr?.os_guess ?? null,
    reverse_dns: enr?.reverse_dns ?? null,
    device_type: enr?.device_type ?? null,
    ai_suggested_label: (ai?.suggested_label as string | null) ?? null,
    ai_inferred_category: (ai?.inferred_category as string | null) ?? null,
    ai_trust_tier: (ai?.trust_tier as string | null) ?? null,
    ai_recommended_qos_profile: (ai?.recommended_qos_profile as string | null) ?? null,
    ai_recommended_down_kbs: ai?.recommended_down_kbs != null ? Number(ai.recommended_down_kbs) : null,
    ai_recommended_up_kbs: ai?.recommended_up_kbs != null ? Number(ai.recommended_up_kbs) : null,
    ai_recommended_wan: (ai?.recommended_wan as string | null) ?? null,
    ai_randomized_match_mac: (ai?.randomized_match_mac as string | null) ?? null,
    ai_randomized_similarity: ai?.randomized_similarity != null ? Number(ai.randomized_similarity) : null,
    ai_rationale_ar: (ai?.rationale_ar as string | null) ?? null,
  };
}

/** Per-hour-of-week heatmap: 24h × 7d grid (avg bytes/sec). */
export function getHeatmap(mac: string | null, days = 14): { dow: number; hour: number; bytes: number }[] {
  const conn = db();
  const since = Date.now() - days * DAY;
  const sql = mac
    ? `SELECT bucket_ts, bytes_down, bytes_up FROM traffic_hour WHERE mac = ? AND bucket_ts >= ? ORDER BY bucket_ts`
    : `SELECT bucket_ts, SUM(bytes_down) AS bytes_down, SUM(bytes_up) AS bytes_up FROM traffic_hour WHERE bucket_ts >= ? GROUP BY bucket_ts ORDER BY bucket_ts`;
  const rows = mac
    ? (conn.prepare(sql).all(mac, since) as any[])
    : (conn.prepare(sql).all(since) as any[]);
  const grid: Record<string, { sum: number; count: number }> = {};
  for (const r of rows) {
    const d = new Date(r.bucket_ts);
    const key = `${d.getDay()}|${d.getHours()}`;
    const e = grid[key] ?? { sum: 0, count: 0 };
    e.sum += Number(r.bytes_down ?? 0) + Number(r.bytes_up ?? 0);
    e.count += 1;
    grid[key] = e;
  }
  const out: { dow: number; hour: number; bytes: number }[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const e = grid[`${dow}|${hour}`];
      out.push({ dow, hour, bytes: e ? Math.round(e.sum / e.count) : 0 });
    }
  }
  return out;
}

/** Concurrent online device count over time. */
export function getConcurrentDevices(minutes = 60 * 24): { ts: number; count: number }[] {
  const conn = db();
  const since = Date.now() - minutes * MIN;
  const rows = conn.prepare(`
    SELECT ts, SUM(online) AS count FROM samples_raw WHERE ts >= ? GROUP BY ts ORDER BY ts
  `).all(since) as { ts: number; count: number }[];
  return rows.map((r) => ({ ts: r.ts, count: Number(r.count ?? 0) }));
}

/** Top-N talkers in a window. */
/**
 * Helper: returns the right "bytes per mac since timestamp" SQL fragment. Picks
 * the coarsest granularity table that fully covers the window, plus the live
 * 5-min table for the in-progress hour. Each row appears in exactly one source
 * table after rollup, so there's no double-counting.
 */
function bytesSinceSql(since: number): { sql: string; params: unknown[] } {
  const rows = trafficRowsSinceSql(since, undefined, true);
  return {
    sql: `
      SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
      FROM (${rows.sql})
      GROUP BY mac
    `,
    params: rows.params,
  };
}

function trafficRowsSinceSql(since: number, mac?: string, allowMonthly = false): { sql: string; params: unknown[] } {
  const now = Date.now();
  const nowDate = new Date(now);
  const startOfHour = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), nowDate.getHours(), 0, 0, 0).getTime();
  const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (table: string, start: number, end?: number) => {
    if (end !== undefined && start >= end) return;
    const where: string[] = [];
    if (mac) {
      where.push('mac = ?');
      params.push(mac);
    }
    where.push('bucket_ts >= ?');
    params.push(start);
    if (end !== undefined) {
      where.push('bucket_ts < ?');
      params.push(end);
    }
    parts.push(`
      SELECT mac, bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
      FROM ${table} WHERE ${where.join(' AND ')}
    `);
  };

  if (since >= startOfHour) {
    add('traffic_5min', since);
    return { sql: parts.join(' UNION ALL '), params };
  }
  if (since >= startOfDay) {
    add('traffic_5min', startOfHour);
    add('traffic_hour', since, startOfHour);
    return { sql: parts.join(' UNION ALL '), params };
  }
  if (!allowMonthly || since >= startOfMonth) {
    add('traffic_5min', startOfHour);
    add('traffic_hour', startOfDay, startOfHour);
    add('traffic_day', since, startOfDay);
    return { sql: parts.join(' UNION ALL '), params };
  }

  // Monthly optimization for long ranges: only use traffic_month on full calendar months
  // so mid-month `since` timestamps never miss partial days at the start of the window.
  const firstFullMonth = (() => {
    if (since <= 0) return 0;
    const mStart = bucketMonth(since);
    if (mStart === since) return since;
    const sd = new Date(since);
    return new Date(sd.getFullYear(), sd.getMonth() + 1, 1).getTime();
  })();

  add('traffic_5min', startOfHour);
  add('traffic_hour', startOfDay, startOfHour);
  add('traffic_day', startOfMonth, startOfDay);
  if (firstFullMonth < startOfMonth) {
    add('traffic_month', firstFullMonth, startOfMonth);
    if (since < firstFullMonth) {
      add('traffic_day', since, firstFullMonth);
    }
  } else {
    add('traffic_day', since, startOfMonth);
  }
  return { sql: parts.join(' UNION ALL '), params };
}

export type TopTalkersRange = 'all' | 'hour' | 'today' | 'week' | 'month';

export function getTopTalkers(range: TopTalkersRange = 'all', limit = 10) {
  if (range === 'all') {
    const allBytes = bytesSinceSql(0);
    return db().prepare(`
      WITH rollups AS (${allBytes.sql}),
      sessions AS (
        SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
        FROM device_sessions
        GROUP BY mac
      )
      SELECT d.mac, COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
             d.category, d.vendor,
             (SELECT ip FROM samples_raw WHERE mac = d.mac ORDER BY ts DESC LIMIT 1) AS ip,
             CASE WHEN r.mac IS NOT NULL THEN COALESCE(r.bd, 0) ELSE COALESCE(s.bd, 0) END AS bytes_down,
             CASE WHEN r.mac IS NOT NULL THEN COALESCE(r.bu, 0) ELSE COALESCE(s.bu, 0) END AS bytes_up
      FROM devices d
      LEFT JOIN rollups r ON r.mac = d.mac
      LEFT JOIN sessions s ON s.mac = d.mac
      WHERE ${EXCLUDE_LOCAL_INFRA_SQL}
      ORDER BY (
        (CASE WHEN r.mac IS NOT NULL THEN COALESCE(r.bd, 0) ELSE COALESCE(s.bd, 0) END) +
        (CASE WHEN r.mac IS NOT NULL THEN COALESCE(r.bu, 0) ELSE COALESCE(s.bu, 0) END)
      ) DESC
      LIMIT ?
    `).all(...allBytes.params, limit);
  }

  const now = Date.now();
  const nowDate = new Date(now);
  let since: number;
  switch (range) {
    case 'hour': since = now - HOUR; break;
    case 'today': since = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime(); break;
    case 'week': since = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 6).getTime(); break;
    case 'month': since = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 29).getTime(); break;
  }
  const { sql, params } = bytesSinceSql(since);
  return db().prepare(`
    SELECT d.mac, COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
           d.category, d.vendor,
           (SELECT ip FROM samples_raw WHERE mac = d.mac ORDER BY ts DESC LIMIT 1) AS ip,
           COALESCE(t.bd, 0) AS bytes_down, COALESCE(t.bu, 0) AS bytes_up
    FROM devices d
    LEFT JOIN (${sql}) t ON t.mac = d.mac
    WHERE ${EXCLUDE_LOCAL_INFRA_SQL}
    ORDER BY (COALESCE(t.bd, 0) + COALESCE(t.bu, 0)) DESC
    LIMIT ?
  `).all(...params, limit);
}

export interface AnomalyItem {
  mac: string;
  label: string;
  hour_ts: number;
  bytes: number;
  baseline: number;
  z: number;
  lan_or_wan: 'lan_only' | 'wan1' | 'wan2' | 'mixed' | 'unknown';
  wan_port: 'WAN1' | 'WAN2' | null;
}

/**
 * Anomaly detection: today's completed hours (`traffic_hour`) + current live hour (`traffic_5min`)
 * per device vs trailing 14-day baseline for THAT EXACT local hour-of-day (`(mac, hour)`),
 * enriched with WAN vs LAN correlation so Frigate/NAS LAN traffic isn't mislabeled as internet burn.
 */
export function getAnomalies(threshold = 3): AnomalyItem[] {
  const conn = db();
  const now = Date.now();
  const startOfHour = (() => {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  })();
  const today = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const baselineSince = today - 14 * DAY;
  const minAnomalyBytes = 10 * 1024 * 1024; // 10 MB noise floor

  const rows = conn
    .prepare(
      `WITH today_hours AS (
         SELECT mac, bucket_ts AS hour_ts, bytes_down + bytes_up AS bytes
         FROM traffic_hour
         WHERE bucket_ts >= ? AND bucket_ts < ?
         UNION ALL
         SELECT mac, ? AS hour_ts, SUM(bytes_down + bytes_up) AS bytes
         FROM traffic_5min
         WHERE bucket_ts >= ?
         GROUP BY mac
       )
       SELECT th.mac, th.hour_ts, SUM(th.bytes) AS bytes,
              COALESCE(d.custom_label, d.router_remark, d.hostname, th.mac) AS label
       FROM today_hours th
       JOIN devices d ON d.mac = th.mac
       GROUP BY th.mac, th.hour_ts
       ORDER BY th.hour_ts`,
    )
    .all(today, startOfHour, startOfHour, startOfHour) as Array<{
    mac: string;
    hour_ts: number;
    bytes: number;
    label: string;
  }>;

  const histRows = conn
    .prepare(
      `SELECT mac, bucket_ts, (bytes_down + bytes_up) AS bytes
       FROM traffic_hour
       WHERE bucket_ts >= ? AND bucket_ts < ?`,
    )
    .all(baselineSince, today) as Array<{ mac: string; bucket_ts: number; bytes: number }>;

  const computeStats = (vals: number[]): { mean: number; stddev: number } | null => {
    if (vals.length < 2) return null;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
    const stddev = Math.sqrt(Math.max(0, variance));
    return { mean, stddev };
  };

  const byMacAndHour = new Map<string, number[]>();
  const byMacOverall = new Map<string, number[]>();
  for (const h of histRows) {
    const hr = new Date(Number(h.bucket_ts)).getHours();
    const b = Number(h.bytes ?? 0);
    const mhKey = `${h.mac}|${hr}`;
    const mhArr = byMacAndHour.get(mhKey) ?? [];
    mhArr.push(b);
    byMacAndHour.set(mhKey, mhArr);

    const mArr = byMacOverall.get(h.mac) ?? [];
    mArr.push(b);
    byMacOverall.set(h.mac, mArr);
  }

  const out: AnomalyItem[] = [];
  for (const r of rows) {
    const bytes = Number(r.bytes ?? 0);
    if (bytes < minAnomalyBytes) continue;
    const hr = new Date(Number(r.hour_ts)).getHours();
    const hourStats = computeStats(byMacAndHour.get(`${r.mac}|${hr}`) ?? []);
    const stats = hourStats ?? computeStats(byMacOverall.get(r.mac) ?? []);
    if (!stats || stats.stddev <= 0) continue;
    const z = (bytes - stats.mean) / stats.stddev;
    if (z >= threshold) {
      let lanOrWan: AnomalyItem['lan_or_wan'] = 'unknown';
      let wanPort: AnomalyItem['wan_port'] = null;
      try {
        const corr = correlateDeviceWindowLanOrWan(conn, bytes, Number(r.hour_ts), Number(r.hour_ts) + HOUR);
        lanOrWan = corr.attribution;
        wanPort = corr.attribution === 'wan1' ? 'WAN1' : corr.attribution === 'wan2' ? 'WAN2' : null;
      } catch {
        // Safe fallback if WAN tables are empty
      }
      out.push({
        mac: r.mac,
        label: r.label,
        hour_ts: Number(r.hour_ts),
        bytes,
        baseline: Math.round(stats.mean),
        z: Number(z.toFixed(2)),
        lan_or_wan: lanOrWan,
        wan_port: wanPort,
      });
    }
  }
  return out.sort((a, b) => b.z - a.z).slice(0, 20);
}

export interface SyslogClusterRow {
  cluster_key: string;
  template: string;
  severity: string;
  sample_message: string;
  count_total: number;
  first_seen_at: number;
  last_seen_at: number;
  ai_summary_ar: string | null;
  ai_remediation_ar: string | null;
}

export function getSyslogClusters(limit = 25): SyslogClusterRow[] {
  const conn = db();
  if (!hasTable(conn, 'ai_syslog_clusters')) return [];
  return conn
    .prepare(
      `SELECT cluster_key, template, severity, sample_message, count_total,
              first_seen_at, last_seen_at, ai_summary_ar, ai_remediation_ar
       FROM ai_syslog_clusters
       ORDER BY last_seen_at DESC, count_total DESC
       LIMIT ?`,
    )
    .all(limit) as SyslogClusterRow[];
}

export interface QosScheduleRow {
  id: number;
  name: string;
  natural_prompt: string | null;
  days_mask: string;
  start_hhmm: string;
  end_hhmm: string;
  target_selector_json: string;
  download_limit_kbs: number;
  upload_limit_kbs: number;
  wan_port: string | null;
  enabled: number;
  last_applied_state: string | null;
  created_at: number;
  updated_at: number;
}

export function getQosSchedules(): QosScheduleRow[] {
  const conn = db();
  if (!hasTable(conn, 'ai_qos_schedules')) return [];
  return conn
    .prepare(
      `SELECT id, name, natural_prompt, days_mask, start_hhmm, end_hhmm,
              target_selector_json, download_limit_kbs, upload_limit_kbs, wan_port,
              enabled, last_applied_state, created_at, updated_at
       FROM ai_qos_schedules
       ORDER BY id DESC`,
    )
    .all() as QosScheduleRow[];
}

export function getDeviceSessions(mac: string, limit = 50) {
  const conn = db();
  return conn.prepare(`
    SELECT started_at, ended_at, bytes_down, bytes_up FROM device_sessions
    WHERE mac = ? ORDER BY started_at DESC LIMIT ?
  `).all(mac, limit);
}

/** Returns categorical breakdown (by hostName→category mapping in devices). */
export function getCategoryBreakdown(range: 'today' | 'week' | 'month' = 'today') {
  const now = Date.now();
  let since: number;
  switch (range) {
    case 'today': { const d = new Date(); d.setHours(0,0,0,0); since = d.getTime(); break; }
    case 'week': since = now - 7 * DAY; break;
    case 'month': since = now - 30 * DAY; break;
  }
  const { sql, params } = bytesSinceSql(since);
  return db().prepare(`
    SELECT COALESCE(d.category, 'unknown') AS category,
           SUM(t.bd) AS bytes_down, SUM(t.bu) AS bytes_up,
           COUNT(DISTINCT d.mac) AS device_count
    FROM (${sql}) t
    JOIN devices d ON d.mac = t.mac
    GROUP BY COALESCE(d.category, 'unknown')
    ORDER BY (SUM(t.bd) + SUM(t.bu)) DESC
  `).all(...params);
}

export interface WanPeriodTotal {
  down: number;
  up: number;
  period_start_ts: number;
}

export interface WanConsumptionSummary {
  first_wan_day_ts: number | null;
  today: WanPeriodTotal;
  week: WanPeriodTotal;
  month: WanPeriodTotal;
  year: WanPeriodTotal;
  total: WanPeriodTotal;
}

export function getWanConsumptionSummary(): WanConsumptionSummary {
  const conn = db();
  const nowDate = new Date();
  const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfWeek = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 6).getTime();
  const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const startOfYear = new Date(nowDate.getFullYear(), 0, 1).getTime();

  if (!hasTable(conn, 'wan_traffic_day')) {
    const zero = (ts: number): WanPeriodTotal => ({ down: 0, up: 0, period_start_ts: ts });
    return {
      first_wan_day_ts: null,
      today: zero(startOfDay),
      week: zero(startOfWeek),
      month: zero(startOfMonth),
      year: zero(startOfYear),
      total: zero(0),
    };
  }

  const minRow = conn.prepare(`SELECT MIN(bucket_ts) AS first_ts FROM wan_traffic_day`).get() as { first_ts: number | null } | undefined;
  const sumSince = (since: number): WanPeriodTotal => {
    const r = conn.prepare(`
      SELECT COALESCE(SUM(bytes_down), 0) AS bd, COALESCE(SUM(bytes_up), 0) AS bu
      FROM wan_traffic_day
      WHERE bucket_ts >= ?
    `).get(since) as { bd: number; bu: number } | undefined;
    return {
      down: Number(r?.bd ?? 0),
      up: Number(r?.bu ?? 0),
      period_start_ts: since,
    };
  };

  return {
    first_wan_day_ts: minRow?.first_ts ?? null,
    today: sumSince(startOfDay),
    week: sumSince(startOfWeek),
    month: sumSince(startOfMonth),
    year: sumSince(startOfYear),
    total: sumSince(0),
  };
}

/**
 * Per-device consumption: returns one row per device with daily/weekly/monthly/yearly totals.
 * Used by /consumption page.
 */
export function getConsumption(): Array<{
  mac: string; label: string; category: string | null; vendor: string | null;
  is_local_infra: boolean;
  now_down_bps: number; now_up_bps: number; online: 0 | 1;
  today_down: number; today_up: number;
  week_down: number; week_up: number;
  month_down: number; month_up: number;
  year_down: number; year_up: number;
  total_down: number; total_up: number;
}> {
  const nowDate = new Date();
  const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfWeek = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 6).getTime(); // last 7 local days (DST-safe)
  const startOfMonth = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const startOfYear = new Date(nowDate.getFullYear(), 0, 1).getTime();

  function bytesAggregate(since: number): { byMac: Map<string, { bd: number; bu: number }> } {
    const { sql, params } = bytesSinceSql(since);
    const rows = db().prepare(sql).all(...params) as Array<{ mac: string; bd: number; bu: number }>;
    const map = new Map<string, { bd: number; bu: number }>();
    for (const r of rows) map.set(r.mac, { bd: Number(r.bd ?? 0), bu: Number(r.bu ?? 0) });
    return { byMac: map };
  }
  const today = bytesAggregate(startOfDay);
  const week = bytesAggregate(startOfWeek);
  const month = bytesAggregate(startOfMonth);
  const year = bytesAggregate(startOfYear);
  const all = bytesAggregate(0);
  const sessions = db().prepare(`
    SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
    FROM device_sessions
    GROUP BY mac
  `).all() as Array<{ mac: string; bd: number; bu: number }>;
  const sessionByMac = new Map(sessions.map((r) => [r.mac, { bd: Number(r.bd ?? 0), bu: Number(r.bu ?? 0) }]));

  const devices = db().prepare(`
    SELECT d.mac, COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
           d.category, d.vendor,
           COALESCE(s.online, 0) AS online,
           COALESCE(s.down_speed_bps, 0) AS now_down_bps,
           COALESCE(s.up_speed_bps, 0) AS now_up_bps
    FROM devices d
    LEFT JOIN (
      SELECT mac, ip, online, down_speed_bps, up_speed_bps
      FROM samples_raw sr
      WHERE ts = (SELECT MAX(ts) FROM samples_raw WHERE mac = sr.mac)
    ) s ON s.mac = d.mac
    ORDER BY d.last_seen DESC
  `).all() as Array<{ mac: string; label: string; category: string | null; vendor: string | null; online: 0 | 1; now_down_bps: number; now_up_bps: number }>;

  return devices.map((d) => {
    const allEntry = all.byMac.get(d.mac);
    const sesEntry = sessionByMac.get(d.mac);
    return {
      mac: d.mac, label: d.label, category: d.category, vendor: d.vendor,
      is_local_infra: isDeviceLocalInfra(d.mac, d.category),
      online: (d.online ?? 0) as 0 | 1,
      now_down_bps: Number(d.now_down_bps ?? 0),
      now_up_bps: Number(d.now_up_bps ?? 0),
      today_down: today.byMac.get(d.mac)?.bd ?? 0,
      today_up: today.byMac.get(d.mac)?.bu ?? 0,
      week_down: week.byMac.get(d.mac)?.bd ?? 0,
      week_up: week.byMac.get(d.mac)?.bu ?? 0,
      month_down: month.byMac.get(d.mac)?.bd ?? 0,
      month_up: month.byMac.get(d.mac)?.bu ?? 0,
      year_down: year.byMac.get(d.mac)?.bd ?? 0,
      year_up: year.byMac.get(d.mac)?.bu ?? 0,
      total_down: allEntry !== undefined ? allEntry.bd : (sesEntry?.bd ?? 0),
      total_up: allEntry !== undefined ? allEntry.bu : (sesEntry?.bu ?? 0),
    };
  }).sort((a, b) => (b.total_down + b.total_up) - (a.total_down + a.total_up));
}

export function getRouterLog(limit = 500) {
  return db().prepare(`
    SELECT id, ts, severity, host, tag, message, src_ip FROM router_log
    ORDER BY id DESC LIMIT ?
  `).all(limit);
}

export interface AttackLogRow {
  router_id: number; ts: number; log_type: number; message: string;
  attacker_ip: string | null; attacker_mac: string | null;
  attack_kind: string | null; attack_count: number | null;
  device_label: string | null;
}

export function getAttackLog(opts: { limit?: number; logType?: number | null; mac?: string | null } = {}): AttackLogRow[] {
  const limit = opts.limit ?? 500;
  let where = '';
  const params: any[] = [];
  if (opts.logType !== undefined && opts.logType !== null) {
    where += ' AND s.log_type = ?';
    params.push(opts.logType);
  }
  if (opts.mac) {
    where += ' AND s.attacker_mac = ?';
    params.push(opts.mac.toUpperCase());
  }
  return db().prepare(`
    SELECT s.router_id, s.ts, s.log_type, s.message, s.attacker_ip, s.attacker_mac,
           s.attack_kind, s.attack_count,
           COALESCE(d.custom_label, d.router_remark, d.hostname, s.attacker_mac) AS device_label
    FROM router_syslog s
    LEFT JOIN devices d ON d.mac = s.attacker_mac
    WHERE 1=1 ${where}
    ORDER BY s.ts DESC LIMIT ?
  `).all(...params, limit) as AttackLogRow[];
}

export function getAttackStats() {
  const conn = db();
  const totals = conn.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN log_type = 2 THEN 1 ELSE 0 END) AS attacks,
           SUM(CASE WHEN log_type = 1 THEN 1 ELSE 0 END) AS system,
           SUM(CASE WHEN log_type = 3 THEN 1 ELSE 0 END) AS quits
    FROM router_syslog
  `).get() as { total: number; attacks: number; system: number; quits: number };

  const topAttackers = conn.prepare(`
    SELECT attacker_mac AS mac, attacker_ip AS ip,
           COALESCE(d.custom_label, d.router_remark, d.hostname, s.attacker_mac) AS label,
           COUNT(*) AS event_count, SUM(attack_count) AS total_attacks,
           MAX(ts) AS latest_ts, attack_kind
    FROM router_syslog s
    LEFT JOIN devices d ON d.mac = s.attacker_mac
    WHERE log_type = 2 AND attacker_mac IS NOT NULL
    GROUP BY attacker_mac, attack_kind
    ORDER BY total_attacks DESC LIMIT 20
  `).all() as Array<any>;

  return { totals, topAttackers };
}

/**
 * Per-device daily breakdown: returns last N days, each day's down/up per device.
 * Used by /report page.
 */
export function getDailyReport(days = 30): {
  days: number[];
  devices: Array<{
    mac: string; label: string; category: string | null; vendor: string | null;
    daily: Array<{ day_ts: number; bytes_down: number; bytes_up: number }>;
    total_down: number; total_up: number;
  }>;
} {
  const todayDate = new Date();
  const dayTimestamps: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayTimestamps.push(new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - i).getTime());
  }
  const earliest = dayTimestamps[0];

  const frag = trafficRowsSinceSql(earliest, undefined, false);
  const rows = db().prepare(frag.sql).all(...frag.params) as Array<{
    mac: string; bucket_ts: number; bytes_down: number; bytes_up: number;
  }>;

  // bucket each row to its day
  const map = new Map<string, Map<number, { bd: number; bu: number }>>();
  for (const r of rows) {
    const dayTs = bucketLocalDay(r.bucket_ts);
    if (dayTs < earliest) continue;
    let inner = map.get(r.mac);
    if (!inner) { inner = new Map(); map.set(r.mac, inner); }
    const e = inner.get(dayTs) ?? { bd: 0, bu: 0 };
    e.bd += Number(r.bytes_down ?? 0);
    e.bu += Number(r.bytes_up ?? 0);
    inner.set(dayTs, e);
  }

  const devices = db().prepare(`
    SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label, category, vendor
    FROM devices ORDER BY last_seen DESC
  `).all() as Array<{ mac: string; label: string; category: string | null; vendor: string | null }>;

  const out = devices.map((d) => {
    const inner = map.get(d.mac);
    const daily = dayTimestamps.map((t) => {
      const e = inner?.get(t);
      return { day_ts: t, bytes_down: e?.bd ?? 0, bytes_up: e?.bu ?? 0 };
    });
    const total_down = daily.reduce((s, d) => s + d.bytes_down, 0);
    const total_up = daily.reduce((s, d) => s + d.bytes_up, 0);
    return { mac: d.mac, label: d.label, category: d.category, vendor: d.vendor, daily, total_down, total_up };
  }).sort((a, b) => (b.total_down + b.total_up) - (a.total_down + a.total_up));

  return { days: dayTimestamps, devices: out };
}

export function getRouterUptimeSeries(days = 30) {
  const conn = db();
  const since = Date.now() - days * DAY;
  return conn.prepare(`
    SELECT ts, uptime_sec, is_reboot, online_count FROM router_state
    WHERE ts >= ? ORDER BY ts
  `).all(since);
}

export function getDeviceAttacks(mac: string) {
  const conn = db();
  const macUp = mac.toUpperCase();
  const summary = conn.prepare(`
    SELECT attack_kind, COUNT(*) AS events, SUM(attack_count) AS total, MAX(ts) AS latest
    FROM router_syslog WHERE attacker_mac = ? AND log_type = 2 GROUP BY attack_kind
  `).all(macUp);
  const recent = conn.prepare(`
    SELECT ts, attack_kind, attack_count, message
    FROM router_syslog WHERE attacker_mac = ? AND log_type = 2 ORDER BY ts DESC LIMIT 30
  `).all(macUp);
  return { summary, recent };
}

/** Per-day usage for a device (last N days). Returns one row per day with bytes down/up + total. */
export function getDeviceDailyUsage(mac: string, days = 30): Array<{
  day_ts: number; day_label: string; bytes_down: number; bytes_up: number; total: number;
}> {
  const conn = db();
  const todayDate = new Date();
  const since = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - (days - 1)).getTime();

  const frag = trafficRowsSinceSql(since, mac, false);
  const sourceRows = conn.prepare(frag.sql).all(...frag.params) as Array<{
    bucket_ts: number; bytes_down: number; bytes_up: number;
  }>;
  const byDay = new Map<number, { day_ts: number; bytes_down: number; bytes_up: number }>();
  for (const r of sourceRows) {
    const dayTs = bucketLocalDay(r.bucket_ts);
    const current = byDay.get(dayTs) ?? { day_ts: dayTs, bytes_down: 0, bytes_up: 0 };
    current.bytes_down += Number(r.bytes_down ?? 0);
    current.bytes_up += Number(r.bytes_up ?? 0);
    byDay.set(dayTs, current);
  }
  const rows = [...byDay.values()].sort((a, b) => b.day_ts - a.day_ts);

  return rows.map((r) => {
    const d = new Date(r.day_ts);
    const day_label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return {
      day_ts: r.day_ts,
      day_label,
      bytes_down: Number(r.bytes_down ?? 0),
      bytes_up: Number(r.bytes_up ?? 0),
      total: Number(r.bytes_down ?? 0) + Number(r.bytes_up ?? 0),
    };
  });
}

export interface DeviceIpEntry {
  ip: string;
  samples: number;
  first_seen: number;
  last_seen: number;
}

/**
 * Distinct IPs a device was ever observed on, with the sample count and the
 * first/last timestamp it appeared at. Useful for surfacing IP roaming on
 * devices with randomized MACs or DHCP renewals.
 */
export function getDeviceIpHistory(mac: string, limit = 50): DeviceIpEntry[] {
  const c = db();
  const rows = c.prepare(`
    SELECT ip, COUNT(*) AS samples, MIN(ts) AS first_seen, MAX(ts) AS last_seen
    FROM samples_raw
    WHERE mac = ? AND ip IS NOT NULL AND ip != ''
    GROUP BY ip
    ORDER BY MAX(ts) DESC
    LIMIT ?
  `).all(mac, limit) as Array<{ ip: string; samples: number; first_seen: number; last_seen: number }>;
  return rows.map((r) => ({
    ip: r.ip,
    samples: Number(r.samples ?? 0),
    first_seen: Number(r.first_seen ?? 0),
    last_seen: Number(r.last_seen ?? 0),
  }));
}

export function getDeviceStats(mac: string) {
  const c = db();
  const allBytes = bytesSinceSql(0);
  const rollupTotals = c.prepare(`
    SELECT COALESCE(bd, 0) AS bytes_down, COALESCE(bu, 0) AS bytes_up
    FROM (${allBytes.sql})
    WHERE mac = ?
  `).get(...allBytes.params, mac) as { bytes_down: number; bytes_up: number } | undefined;
  const sessionTotals = c.prepare(`
    SELECT COALESCE(SUM(bytes_down), 0) AS bytes_down, COALESCE(SUM(bytes_up), 0) AS bytes_up
    FROM device_sessions
    WHERE mac = ?
  `).get(mac) as { bytes_down: number; bytes_up: number } | undefined;

  const peaks = c.prepare(`
    SELECT MAX(down_speed_bps) AS peak_down, MAX(up_speed_bps) AS peak_up
    FROM samples_raw WHERE mac = ?
  `).get(mac) as { peak_down: number; peak_up: number } | undefined;

  return {
    bytes_down: rollupTotals !== undefined ? Number(rollupTotals.bytes_down ?? 0) : Number(sessionTotals?.bytes_down ?? 0),
    bytes_up: rollupTotals !== undefined ? Number(rollupTotals.bytes_up ?? 0) : Number(sessionTotals?.bytes_up ?? 0),
    peak_down_bps: peaks?.peak_down ?? 0,
    peak_up_bps: peaks?.peak_up ?? 0,
  };
}
