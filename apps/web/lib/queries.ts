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
  alerts_undismissed: number;
}

export function getLatestDevices(): DeviceRow[] {
  const conn = db();
  const startOfDay = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  // Latest sample per device
  const rows = conn.prepare(`
    WITH latest AS (
      SELECT mac, MAX(ts) AS ts FROM samples_raw GROUP BY mac
    ),
    today_5 AS (
      SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
      FROM traffic_5min WHERE bucket_ts >= @startOfDay GROUP BY mac
    ),
    today_h AS (
      SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu
      FROM traffic_hour WHERE bucket_ts >= @startOfDay GROUP BY mac
    ),
    all_5 AS (SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM traffic_5min GROUP BY mac),
    all_h AS (SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM traffic_hour GROUP BY mac),
    all_d AS (SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM traffic_day GROUP BY mac),
    all_m AS (SELECT mac, SUM(bytes_down) AS bd, SUM(bytes_up) AS bu FROM traffic_month GROUP BY mac)
    SELECT d.mac, d.hostname, d.router_remark, d.custom_label, d.vendor, d.category,
           d.is_new, d.last_seen, d.first_seen,
           s.ip, s.online, s.up_speed_bps, s.down_speed_bps,
           COALESCE(t5.bd, 0) + COALESCE(th.bd, 0) AS bytes_today,
           COALESCE(t5.bu, 0) + COALESCE(th.bu, 0) AS bytes_up_today,
           COALESCE(a5.bd, 0) + COALESCE(ah.bd, 0) + COALESCE(ad.bd, 0) + COALESCE(am.bd, 0) AS bytes_total,
           COALESCE(a5.bu, 0) + COALESCE(ah.bu, 0) + COALESCE(ad.bu, 0) + COALESCE(am.bu, 0) AS bytes_up_total
    FROM devices d
    LEFT JOIN latest l ON l.mac = d.mac
    LEFT JOIN samples_raw s ON s.mac = d.mac AND s.ts = l.ts
    LEFT JOIN today_5 t5 ON t5.mac = d.mac
    LEFT JOIN today_h th ON th.mac = d.mac
    LEFT JOIN all_5 a5 ON a5.mac = d.mac
    LEFT JOIN all_h ah ON ah.mac = d.mac
    LEFT JOIN all_d ad ON ad.mac = d.mac
    LEFT JOIN all_m am ON am.mac = d.mac
    ORDER BY bytes_today DESC, d.last_seen DESC
  `).all({ startOfDay }) as DeviceRow[];
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
    ) GROUP BY mac ORDER BY bd DESC LIMIT 1
  `).get(startOfDay, startOfDay) as { mac: string; bd: number } | undefined;

  let topDevice = null as RouterSnapshot['top_device'];
  if (topToday) {
    const d = conn.prepare(`SELECT mac, COALESCE(custom_label, hostname, mac) AS label FROM devices WHERE mac = ?`).get(topToday.mac) as { mac: string; label: string };
    topDevice = { mac: d.mac, label: d.label, bytes_down: topToday.bd };
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
  return db().prepare(`SELECT * FROM devices WHERE mac = ?`).get(mac);
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
export function getTopTalkers(range: 'hour' | 'today' | 'week' | 'month' = 'today', limit = 10) {
  const conn = db();
  const now = Date.now();
  let since: number;
  switch (range) {
    case 'hour': since = now - HOUR; break;
    case 'today': { const d = new Date(); d.setHours(0,0,0,0); since = d.getTime(); break; }
    case 'week': since = now - 7 * DAY; break;
    case 'month': since = now - 30 * DAY; break;
  }
  return conn.prepare(`
    SELECT d.mac, COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
           d.category, d.vendor,
           SUM(t.bd) AS bytes_down, SUM(t.bu) AS bytes_up
    FROM (
      SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_day WHERE bucket_ts >= ?
    ) t
    JOIN devices d ON d.mac = t.mac
    GROUP BY d.mac
    ORDER BY (SUM(t.bd) + SUM(t.bu)) DESC
    LIMIT ?
  `).all(since, since, since, limit);
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
  const conn = db();
  const now = Date.now();
  let since: number;
  switch (range) {
    case 'today': { const d = new Date(); d.setHours(0,0,0,0); since = d.getTime(); break; }
    case 'week': since = now - 7 * DAY; break;
    case 'month': since = now - 30 * DAY; break;
  }
  return conn.prepare(`
    SELECT COALESCE(d.category, 'unknown') AS category,
           SUM(t.bd) AS bytes_down, SUM(t.bu) AS bytes_up,
           COUNT(DISTINCT d.mac) AS device_count
    FROM (
      SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= ?
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_day WHERE bucket_ts >= ?
    ) t
    JOIN devices d ON d.mac = t.mac
    GROUP BY COALESCE(d.category, 'unknown')
    ORDER BY (SUM(t.bd) + SUM(t.bu)) DESC
  `).all(since, since, since);
}

export function getRouterUptimeSeries(days = 30) {
  const conn = db();
  const since = Date.now() - days * DAY;
  return conn.prepare(`
    SELECT ts, uptime_sec, is_reboot, online_count FROM router_state
    WHERE ts >= ? ORDER BY ts
  `).all(since);
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
