import 'server-only';
import { db } from './db';
import { bucket5Min, bucketHour, bucketDay, bucketMonth, HOUR, DAY, MIN } from '@tenda/shared';

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
           MAX(COALESCE(ses.bd, 0), COALESCE(at.bd, 0)) AS bytes_total,
           MAX(COALESCE(ses.bu, 0), COALESCE(at.bu, 0)) AS bytes_up_total,
           CASE WHEN res.mac IS NOT NULL THEN 1 ELSE 0 END AS reserved,
           res.ip AS reserved_ip
    FROM devices d
    LEFT JOIN latest l ON l.mac = d.mac
    LEFT JOIN samples_raw s ON s.mac = d.mac AND s.ts = l.ts
    LEFT JOIN last_online lo ON lo.mac = d.mac
    LEFT JOIN today td ON td.mac = d.mac
    LEFT JOIN alltime at ON at.mac = d.mac
    LEFT JOIN sessions ses ON ses.mac = d.mac
    LEFT JOIN dhcp_reservations res ON res.mac = d.mac
    ORDER BY bytes_today DESC, d.last_seen DESC
  `).all(...todayBytes.params, ...allBytes.params) as DeviceRow[];
  return rows.map((r) => ({
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
  }));
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
    SELECT COALESCE(SUM(bytes_down), 0) AS bd, COALESCE(SUM(bytes_up), 0) AS bu
    FROM traffic_5min WHERE bucket_ts >= ?
  `).get(startOfDay) as { bd: number; bu: number };
  const thTotals = conn.prepare(`
    SELECT COALESCE(SUM(bytes_down), 0) AS bd, COALESCE(SUM(bytes_up), 0) AS bu
    FROM traffic_hour WHERE bucket_ts >= ?
  `).get(startOfDay) as { bd: number; bu: number };
  const todayTotals = {
    bytes_down: Number(t5Totals.bd) + Number(thTotals.bd),
    bytes_up: Number(t5Totals.bu) + Number(thTotals.bu),
  };

  const topToday = conn.prepare(`
    SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM (
      SELECT mac, bytes_down, bytes_up FROM traffic_5min WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ?
    ) GROUP BY mac ORDER BY (bd + bu) DESC LIMIT 2
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
    SELECT ts, SUM(down_speed_bps) AS down_bps, SUM(up_speed_bps) AS up_bps
    FROM samples_raw
    WHERE ts >= ?
    GROUP BY ts
    ORDER BY ts ASC
  `).all(since) as LiveSpeedPoint[];
}

function getDeviceCounterRecentSpeeds(conn: ReturnType<typeof db>, since: number): LiveSpeedPoint[] {
  return conn.prepare(`
    WITH recent AS (
      SELECT
        mac,
        ts,
        down_sum_kb,
        up_speed_bps,
        LAG(ts) OVER (PARTITION BY mac ORDER BY ts) AS prev_ts,
        LAG(down_sum_kb) OVER (PARTITION BY mac ORDER BY ts) AS prev_down_sum_kb
      FROM samples_raw
      WHERE ts >= ?
    )
    SELECT
      ts,
      SUM(
        CASE
          WHEN prev_ts IS NULL THEN 0
          WHEN ts < ? THEN 0
          WHEN ts <= prev_ts THEN 0
          WHEN ts - prev_ts > ? THEN 0
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
      const since = now - 7 * DAY;
      const frag = trafficRowsSinceSql(since, mac);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketLocalDay);
    }
    case 'month': {
      const since = now - 30 * DAY;
      const frag = trafficRowsSinceSql(since, mac);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketLocalDay);
    }
    case 'year': {
      const since = now - 365 * DAY;
      const frag = trafficRowsSinceSql(since, mac);
      const rows = conn.prepare(frag.sql).all(...frag.params) as BucketPoint[];
      return aggregateRows(rows, bucketMonth);
    }
    case 'all': {
      const frag = trafficRowsSinceSql(0, mac);
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

function deleteWhereIfColumnExists(conn: ReturnType<typeof db>, table: string, column: string, value: string): number {
  const tableRow = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { name: string } | undefined;
  if (!tableRow) return 0;
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) return 0;
  return Number(conn.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value).changes ?? 0);
}

function deleteWhereTextContainsIfColumnExists(conn: ReturnType<typeof db>, table: string, column: string, value: string): number {
  const tableRow = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { name: string } | undefined;
  if (!tableRow) return 0;
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) return 0;
  return Number(conn.prepare(`DELETE FROM ${table} WHERE ${column} LIKE ?`).run(`%${value}%`).changes ?? 0);
}

export function getDevice(mac: string) {
  return db().prepare(`
    SELECT d.*,
           (SELECT MAX(ts) FROM samples_raw sr_online WHERE sr_online.mac = d.mac AND sr_online.online = 1) AS last_online_at,
           s.ip, s.online, s.connect_type, s.connection_kind, s.wifi_band, s.wifi_rssi_dbm,
           s.wifi_signal_percent, s.wifi_distance_m, s.wifi_distance_source,
           COALESCE(s.up_speed_bps, 0) AS up_speed_bps,
           COALESCE(s.down_speed_bps, 0) AS down_speed_bps,
           CASE WHEN res.mac IS NOT NULL THEN 1 ELSE 0 END AS reserved,
           res.ip AS reserved_ip
    FROM devices d
    LEFT JOIN (
      SELECT *
      FROM samples_raw
      WHERE mac = ?
      ORDER BY ts DESC
      LIMIT 1
    ) s ON s.mac = d.mac
    LEFT JOIN dhcp_reservations res ON res.mac = d.mac
    WHERE d.mac = ?
  `).get(mac, mac);
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
  const rows = trafficRowsSinceSql(since);
  return {
    sql: `
      SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
      FROM (${rows.sql})
      GROUP BY mac
    `,
    params: rows.params,
  };
}

function trafficRowsSinceSql(since: number, mac?: string): { sql: string; params: unknown[] } {
  const now = Date.now();
  const startOfHour = (() => { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); })();
  const startOfDay = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const startOfMonth = (() => { const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (table: string, start: number, end?: number) => {
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
  if (since >= startOfMonth) {
    add('traffic_5min', startOfHour);
    add('traffic_hour', startOfDay, startOfHour);
    add('traffic_day', since, startOfDay);
    return { sql: parts.join(' UNION ALL '), params };
  }
  add('traffic_5min', startOfHour);
  add('traffic_hour', startOfDay, startOfHour);
  add('traffic_day', startOfMonth, startOfDay);
  add('traffic_month', since, startOfMonth);
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
             MAX(COALESCE(s.bd, 0), COALESCE(r.bd, 0)) AS bytes_down,
             MAX(COALESCE(s.bu, 0), COALESCE(r.bu, 0)) AS bytes_up
      FROM devices d
      LEFT JOIN rollups r ON r.mac = d.mac
      LEFT JOIN sessions s ON s.mac = d.mac
      ORDER BY (
        MAX(COALESCE(s.bd, 0), COALESCE(r.bd, 0)) +
        MAX(COALESCE(s.bu, 0), COALESCE(r.bu, 0))
      ) DESC
      LIMIT ?
    `).all(...allBytes.params, limit);
  }

  const now = Date.now();
  let since: number;
  switch (range) {
    case 'hour': since = now - HOUR; break;
    case 'today': { const d = new Date(); d.setHours(0,0,0,0); since = d.getTime(); break; }
    case 'week': since = now - 7 * DAY; break;
    case 'month': since = now - 30 * DAY; break;
  }
  const { sql, params } = bytesSinceSql(since);
  return db().prepare(`
    SELECT d.mac, COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
           d.category, d.vendor,
           (SELECT ip FROM samples_raw WHERE mac = d.mac ORDER BY ts DESC LIMIT 1) AS ip,
           COALESCE(t.bd, 0) AS bytes_down, COALESCE(t.bu, 0) AS bytes_up
    FROM devices d
    LEFT JOIN (${sql}) t ON t.mac = d.mac
    ORDER BY (COALESCE(t.bd, 0) + COALESCE(t.bu, 0)) DESC
    LIMIT ?
  `).all(...params, limit);
}

/** Anomaly detection: today's hourly bytes per device vs trailing 14-day average for that hour. */
export function getAnomalies(threshold = 3): Array<{ mac: string; label: string; hour_ts: number; bytes: number; baseline: number; z: number }> {
  const conn = db();
  const today = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const baselineSince = today - 14 * DAY;
  const rows = conn.prepare(`
    SELECT t.mac, t.bucket_ts AS hour_ts, t.bytes_down + t.bytes_up AS bytes,
           COALESCE(d.custom_label, d.router_remark, d.hostname, t.mac) AS label
    FROM traffic_hour t
    JOIN devices d ON d.mac = t.mac
    WHERE t.bucket_ts >= ?
    ORDER BY t.bucket_ts
  `).all(today) as any[];
  const baseline = conn.prepare(`
    SELECT mac, AVG(bytes_down + bytes_up) AS mean,
           CASE WHEN COUNT(*) > 1
                THEN SQRT(AVG((bytes_down + bytes_up) * (bytes_down + bytes_up)) - AVG(bytes_down + bytes_up) * AVG(bytes_down + bytes_up))
                ELSE 0 END AS stddev
    FROM traffic_hour WHERE bucket_ts >= ? AND bucket_ts < ?
    GROUP BY mac
  `).all(baselineSince, today) as any[];
  const baselineMap = new Map<string, { mean: number; stddev: number }>();
  for (const b of baseline) baselineMap.set(b.mac, { mean: Number(b.mean ?? 0), stddev: Number(b.stddev ?? 0) });
  const out: any[] = [];
  for (const r of rows) {
    const b = baselineMap.get(r.mac);
    if (!b || b.stddev <= 0) continue;
    const z = (Number(r.bytes) - b.mean) / b.stddev;
    if (z >= threshold) {
      out.push({ mac: r.mac, label: r.label, hour_ts: r.hour_ts, bytes: Number(r.bytes), baseline: Math.round(b.mean), z: Number(z.toFixed(2)) });
    }
  }
  return out.sort((a, b) => b.z - a.z).slice(0, 20);
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

/**
 * Per-device consumption: returns one row per device with daily/weekly/monthly/yearly totals.
 * Used by /consumption page.
 */
export function getConsumption(): Array<{
  mac: string; label: string; category: string | null; vendor: string | null;
  now_down_bps: number; now_up_bps: number; online: 0 | 1;
  today_down: number; today_up: number;
  week_down: number; week_up: number;
  month_down: number; month_up: number;
  year_down: number; year_up: number;
  total_down: number; total_up: number;
}> {
  const now = Date.now();
  const startOfDay = (() => { const d = new Date(now); d.setHours(0,0,0,0); return d.getTime(); })();
  const startOfWeek = startOfDay - 6 * DAY; // last 7 days
  const startOfMonth = (() => { const d = new Date(now); d.setDate(1); d.setHours(0,0,0,0); return d.getTime(); })();
  const startOfYear = (() => { const d = new Date(now); d.setMonth(0, 1); d.setHours(0,0,0,0); return d.getTime(); })();

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

  return devices.map((d) => ({
    mac: d.mac, label: d.label, category: d.category, vendor: d.vendor,
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
    total_down: Math.max(all.byMac.get(d.mac)?.bd ?? 0, sessionByMac.get(d.mac)?.bd ?? 0),
    total_up: Math.max(all.byMac.get(d.mac)?.bu ?? 0, sessionByMac.get(d.mac)?.bu ?? 0),
  })).sort((a, b) => (b.total_down + b.total_up) - (a.total_down + a.total_up));
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
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const today = (() => { const d = new Date(now); d.setHours(0,0,0,0); return d.getTime(); })();
  const dayTimestamps: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayTimestamps.push(today - i * dayMs);
  }
  const earliest = dayTimestamps[0];

  const frag = trafficRowsSinceSql(earliest);
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
  const today = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const since = today - (days - 1) * DAY;

  const frag = trafficRowsSinceSql(since, mac);
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
    bytes_down: Math.max(Number(rollupTotals?.bytes_down ?? 0), Number(sessionTotals?.bytes_down ?? 0)),
    bytes_up: Math.max(Number(rollupTotals?.bytes_up ?? 0), Number(sessionTotals?.bytes_up ?? 0)),
    peak_down_bps: peaks?.peak_down ?? 0,
    peak_up_bps: peaks?.peak_up ?? 0,
  };
}
