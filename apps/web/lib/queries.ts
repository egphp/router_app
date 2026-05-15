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
  bytes_today: number;
  bytes_up_today: number;
  bytes_total: number;
  bytes_up_total: number;
  is_new: 0 | 1;
  last_seen: number;
  first_seen: number;
}

export interface RouterSnapshot {
  uptime_sec: number;
  online_count: number;
  total_devices: number;
  last_sample_ts: number | null;
  bytes_today_down: number;
  bytes_today_up: number;
  top_device: { mac: string; label: string; bytes_down: number } | null;
  top_device_2: { mac: string; label: string; bytes_down: number } | null;
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
    today AS (${todayBytes.sql}),
    alltime AS (${allBytes.sql})
    SELECT d.mac, d.hostname, d.router_remark, d.custom_label, d.vendor, d.category,
           d.is_new, d.last_seen, d.first_seen,
           s.ip, s.online, s.up_speed_bps, s.down_speed_bps,
           COALESCE(td.bd, 0) AS bytes_today,
           COALESCE(td.bu, 0) AS bytes_up_today,
           COALESCE(at.bd, 0) AS bytes_total,
           COALESCE(at.bu, 0) AS bytes_up_total
    FROM devices d
    LEFT JOIN latest l ON l.mac = d.mac
    LEFT JOIN samples_raw s ON s.mac = d.mac AND s.ts = l.ts
    LEFT JOIN today td ON td.mac = d.mac
    LEFT JOIN alltime at ON at.mac = d.mac
    ORDER BY bytes_today DESC, d.last_seen DESC
  `).all(...todayBytes.params, ...allBytes.params) as DeviceRow[];
  return rows.map((r) => ({
    ...r,
    online: (r.online ?? 0) as 0 | 1,
    up_speed_bps: r.up_speed_bps ?? 0,
    down_speed_bps: r.down_speed_bps ?? 0,
    bytes_today: Number(r.bytes_today ?? 0),
    bytes_up_today: Number(r.bytes_up_today ?? 0),
    bytes_total: Number(r.bytes_total ?? 0),
    bytes_up_total: Number(r.bytes_up_total ?? 0),
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

  const todayTotals = conn.prepare(`
    SELECT
      COALESCE(SUM(t5.bd), 0) + COALESCE(SUM(th.bd), 0) AS bytes_down,
      COALESCE(SUM(t5.bu), 0) + COALESCE(SUM(th.bu), 0) AS bytes_up
    FROM (
      SELECT 0 AS bd, 0 AS bu
      UNION ALL SELECT SUM(bytes_down), SUM(bytes_up) FROM traffic_5min WHERE bucket_ts >= ?
    ) t5
    CROSS JOIN (
      SELECT 0 AS bd, 0 AS bu
      UNION ALL SELECT SUM(bytes_down), SUM(bytes_up) FROM traffic_hour WHERE bucket_ts >= ?
    ) th
  `).get(startOfDay, startOfDay) as { bytes_down: number; bytes_up: number };

  const topToday = conn.prepare(`
    SELECT mac, SUM(bytes_down) AS bd FROM (
      SELECT mac, bytes_down FROM traffic_5min WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down FROM traffic_hour WHERE bucket_ts >= ?
    ) GROUP BY mac ORDER BY bd DESC LIMIT 2
  `).all(startOfDay, startOfDay) as Array<{ mac: string; bd: number }>;

  let topDevice = null as RouterSnapshot['top_device'];
  let topDevice2 = null as RouterSnapshot['top_device'];
  if (topToday[0]) {
    const d = conn.prepare(`SELECT mac, COALESCE(custom_label, hostname, mac) AS label FROM devices WHERE mac = ?`).get(topToday[0].mac) as { mac: string; label: string };
    topDevice = { mac: d.mac, label: d.label, bytes_down: topToday[0].bd };
  }
  if (topToday[1]) {
    const d = conn.prepare(`SELECT mac, COALESCE(custom_label, hostname, mac) AS label FROM devices WHERE mac = ?`).get(topToday[1].mac) as { mac: string; label: string };
    topDevice2 = { mac: d.mac, label: d.label, bytes_down: topToday[1].bd };
  }

  const counts = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices) AS total,
      (SELECT COUNT(*) FROM alerts WHERE dismissed_at IS NULL) AS alerts
  `).get() as { total: number; alerts: number };

  return {
    uptime_sec: latest?.uptime_sec ?? 0,
    online_count: latest?.online_count ?? 0,
    total_devices: counts.total,
    last_sample_ts: latest?.ts ?? null,
    bytes_today_down: Number(todayTotals.bytes_down ?? 0),
    bytes_today_up: Number(todayTotals.bytes_up ?? 0),
    top_device: topDevice,
    top_device_2: topDevice2,
    alerts_undismissed: counts.alerts,
  };
}

export interface LiveSpeedPoint { ts: number; down_bps: number; up_bps: number }

export function getRecentSpeeds(minutes = 60): LiveSpeedPoint[] {
  const conn = db();
  const since = Date.now() - minutes * MIN;
  const rows = conn.prepare(`
    SELECT ts, SUM(down_speed_bps) AS down_bps, SUM(up_speed_bps) AS up_bps
    FROM samples_raw
    WHERE ts >= ?
    GROUP BY ts
    ORDER BY ts ASC
  `).all(since) as LiveSpeedPoint[];
  return rows;
}

export type Bucket = 'hour' | 'today' | 'week' | 'month' | 'year' | 'all';

export interface BucketPoint { bucket_ts: number; bytes_down: number; bytes_up: number; peak_down_bps?: number; peak_up_bps?: number }

export function getDeviceTraffic(mac: string, range: Bucket): BucketPoint[] {
  const conn = db();
  const now = Date.now();
  switch (range) {
    case 'hour': {
      // last 60 min of 5-min buckets
      const since = now - HOUR;
      return conn.prepare(`
        SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
        FROM traffic_5min WHERE mac = ? AND bucket_ts >= ?
        ORDER BY bucket_ts ASC
      `).all(mac, since) as BucketPoint[];
    }
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      const since = d.getTime();
      // combine recent 5-min + hour (5-min for the current hour, hour for completed hours)
      return conn.prepare(`
        SELECT bucket_ts, SUM(bytes_down) AS bytes_down, SUM(bytes_up) AS bytes_up,
               MAX(peak_down_bps) AS peak_down_bps, MAX(peak_up_bps) AS peak_up_bps
        FROM (
          SELECT ${makeBucketExpr('bucket_ts', HOUR)} AS bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
          FROM traffic_5min WHERE mac = ? AND bucket_ts >= ?
          UNION ALL
          SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
          FROM traffic_hour WHERE mac = ? AND bucket_ts >= ?
        ) GROUP BY bucket_ts ORDER BY bucket_ts ASC
      `).all(mac, since, mac, since) as BucketPoint[];
    }
    case 'week': {
      const since = now - 7 * DAY;
      return conn.prepare(`
        SELECT bucket_ts, SUM(bytes_down) AS bytes_down, SUM(bytes_up) AS bytes_up,
               MAX(peak_down_bps) AS peak_down_bps, MAX(peak_up_bps) AS peak_up_bps
        FROM (
          SELECT ${makeBucketExpr('bucket_ts', DAY)} AS bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
          FROM traffic_hour WHERE mac = ? AND bucket_ts >= ?
          UNION ALL
          SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
          FROM traffic_day WHERE mac = ? AND bucket_ts >= ?
        ) GROUP BY bucket_ts ORDER BY bucket_ts ASC
      `).all(mac, since, mac, since) as BucketPoint[];
    }
    case 'month': {
      const since = now - 30 * DAY;
      return conn.prepare(`
        SELECT bucket_ts, SUM(bytes_down) AS bytes_down, SUM(bytes_up) AS bytes_up,
               MAX(peak_down_bps) AS peak_down_bps, MAX(peak_up_bps) AS peak_up_bps
        FROM (
          SELECT ${makeBucketExpr('bucket_ts', DAY)} AS bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
          FROM traffic_hour WHERE mac = ? AND bucket_ts >= ?
          UNION ALL
          SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
          FROM traffic_day WHERE mac = ? AND bucket_ts >= ?
        ) GROUP BY bucket_ts ORDER BY bucket_ts ASC
      `).all(mac, since, mac, since) as BucketPoint[];
    }
    case 'year': {
      const since = now - 365 * DAY;
      return conn.prepare(`
        SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
        FROM traffic_month WHERE mac = ? AND bucket_ts >= ?
        ORDER BY bucket_ts ASC
      `).all(mac, since) as BucketPoint[];
    }
    case 'all': {
      return conn.prepare(`
        SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
        FROM traffic_month WHERE mac = ?
        ORDER BY bucket_ts ASC
      `).all(mac) as BucketPoint[];
    }
  }
}

function makeBucketExpr(field: string, ms: number): string {
  return `((${field}) / ${ms}) * ${ms}`;
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

export function getDevice(mac: string) {
  return db().prepare(`
    SELECT d.*,
           (SELECT ip FROM samples_raw WHERE mac = d.mac ORDER BY ts DESC LIMIT 1) AS ip
    FROM devices d WHERE d.mac = ?
  `).get(mac);
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
function bytesSinceSql(since: number): { sql: string; params: number[] } {
  const now = Date.now();
  const startOfHour = (() => { const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime(); })();
  const startOfDay = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const startOfMonth = (() => { const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  if (since >= startOfHour) {
    // Window is inside the current hour — only 5min has data
    return {
      sql: `SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM traffic_5min WHERE bucket_ts >= ? GROUP BY mac`,
      params: [since],
    };
  }
  if (since >= startOfDay) {
    return {
      sql: `
        SELECT mac, SUM(bd) AS bd, SUM(bu) AS bu FROM (
          SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
          UNION ALL
          SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ? AND bucket_ts < ?
        ) GROUP BY mac
      `,
      params: [startOfHour, since, startOfHour],
    };
  }
  if (since >= startOfMonth) {
    return {
      sql: `
        SELECT mac, SUM(bd) AS bd, SUM(bu) AS bu FROM (
          SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
          UNION ALL
          SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ? AND bucket_ts < ?
          UNION ALL
          SELECT mac, bytes_down, bytes_up FROM traffic_day WHERE bucket_ts >= ? AND bucket_ts < ?
        ) GROUP BY mac
      `,
      params: [startOfHour, startOfDay, startOfHour, since, startOfDay],
    };
  }
  // Long-range: include month-level
  return {
    sql: `
      SELECT mac, SUM(bd) AS bd, SUM(bu) AS bu FROM (
        SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
        UNION ALL
        SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ? AND bucket_ts < ?
        UNION ALL
        SELECT mac, bytes_down, bytes_up FROM traffic_day WHERE bucket_ts >= ? AND bucket_ts < ?
        UNION ALL
        SELECT mac, bytes_down, bytes_up FROM traffic_month WHERE bucket_ts >= ? AND bucket_ts < ?
      ) GROUP BY mac
    `,
    params: [startOfHour, startOfDay, startOfHour, startOfMonth, startOfDay, since, startOfMonth],
  };
}

export function getTopTalkers(range: 'hour' | 'today' | 'week' | 'month' = 'today', limit = 10) {
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

  const devices = db().prepare(`
    SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label, category, vendor
    FROM devices ORDER BY last_seen DESC
  `).all() as Array<{ mac: string; label: string; category: string | null; vendor: string | null }>;

  return devices.map((d) => ({
    mac: d.mac, label: d.label, category: d.category, vendor: d.vendor,
    today_down: today.byMac.get(d.mac)?.bd ?? 0,
    today_up: today.byMac.get(d.mac)?.bu ?? 0,
    week_down: week.byMac.get(d.mac)?.bd ?? 0,
    week_up: week.byMac.get(d.mac)?.bu ?? 0,
    month_down: month.byMac.get(d.mac)?.bd ?? 0,
    month_up: month.byMac.get(d.mac)?.bu ?? 0,
    year_down: year.byMac.get(d.mac)?.bd ?? 0,
    year_up: year.byMac.get(d.mac)?.bu ?? 0,
    total_down: all.byMac.get(d.mac)?.bd ?? 0,
    total_up: all.byMac.get(d.mac)?.bu ?? 0,
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

  // Aggregate per (mac, day) bytes from all granularity tables, then bucket-by-day in JS.
  const rows = db().prepare(`
    SELECT mac, bucket_ts AS ts, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
    UNION ALL
    SELECT mac, bucket_ts, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ?
    UNION ALL
    SELECT mac, bucket_ts, bytes_down, bytes_up FROM traffic_day WHERE bucket_ts >= ?
    UNION ALL
    SELECT mac, bucket_ts, bytes_down, bytes_up FROM traffic_month WHERE bucket_ts >= ?
  `).all(earliest, earliest, earliest, earliest) as Array<{ mac: string; ts: number; bd: number; bu: number }>;

  // bucket each row to its day
  const map = new Map<string, Map<number, { bd: number; bu: number }>>();
  for (const r of rows) {
    const d = new Date(r.ts);
    d.setHours(0,0,0,0);
    const dayTs = d.getTime();
    if (dayTs < earliest) continue;
    let inner = map.get(r.mac);
    if (!inner) { inner = new Map(); map.set(r.mac, inner); }
    const e = inner.get(dayTs) ?? { bd: 0, bu: 0 };
    e.bd += Number(r.bd ?? 0);
    e.bu += Number(r.bu ?? 0);
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

export function getDeviceStats(mac: string) {
  const c = db();
  const totals = c.prepare(`
    SELECT
      COALESCE(SUM(bd), 0) AS bytes_down, COALESCE(SUM(bu), 0) AS bytes_up
    FROM (
      SELECT SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM traffic_5min WHERE mac = ?
      UNION ALL SELECT SUM(bytes_down), SUM(bytes_up) FROM traffic_hour WHERE mac = ?
      UNION ALL SELECT SUM(bytes_down), SUM(bytes_up) FROM traffic_day WHERE mac = ?
      UNION ALL SELECT SUM(bytes_down), SUM(bytes_up) FROM traffic_month WHERE mac = ?
    )
  `).get(mac, mac, mac, mac) as { bytes_down: number; bytes_up: number };

  const peaks = c.prepare(`
    SELECT MAX(down_speed_bps) AS peak_down, MAX(up_speed_bps) AS peak_up
    FROM samples_raw WHERE mac = ?
  `).get(mac) as { peak_down: number; peak_up: number } | undefined;

  return {
    bytes_down: Number(totals?.bytes_down ?? 0),
    bytes_up: Number(totals?.bytes_up ?? 0),
    peak_down_bps: peaks?.peak_down ?? 0,
    peak_up_bps: peaks?.peak_up ?? 0,
  };
}
