import type Database from 'better-sqlite3';
import {
  DAY,
  HOUR,
  getDeviceThresholds,
  getThresholdConfig,
  insertAlertIfAllowed,
  markNotificationState,
  sendDownloadThresholdPush,
  type ThresholdPeriod,
} from '@tenda/shared';
import { log } from './logger.js';

interface DeviceUsage {
  mac: string;
  label: string;
  bytes_down: number;
}

export class ThresholdAlertMonitor {
  constructor(private readonly db: Database.Database) {}

  async scan(now: number): Promise<void> {
    const cfg = getThresholdConfig(this.db);
    if (cfg.totalEnabled && cfg.totalLimitBytes > 0) {
      await this.checkTotal(now, cfg.totalPeriod, cfg.totalLimitBytes);
    }
    if (cfg.deviceEnabled) {
      await this.checkDevices(now, cfg.deviceDefaultPeriod, cfg.deviceDefaultLimitBytes);
    }
  }

  private async checkTotal(now: number, period: ThresholdPeriod, thresholdBytes: number): Promise<void> {
    const total = totalDownloadForPeriod(this.db, period);
    if (total < thresholdBytes) return;
    const stateKey = thresholdStateKey('total_download_threshold', period, null, thresholdBytes, now);
    if (!markNotificationState(this.db, stateKey, total, now)) return;
    const payload = {
      rule: 'total_download_threshold',
      period,
      bytes_down: total,
      threshold_bytes: thresholdBytes,
      message: `Total download crossed ${formatBytes(thresholdBytes)} (${formatBytes(total)} used).`,
    };
    const alert = insertAlertIfAllowed(this.db, 'total_download_threshold', null, payload, now);
    if (!alert.inserted) return;
    const result = await sendDownloadThresholdPush(this.db, {
      kind: 'total_download_threshold',
      period,
      bytes: total,
      thresholdBytes,
    });
    log.warn('total-download threshold push result', { period, thresholdBytes, total, ...result });
  }

  private async checkDevices(now: number, defaultPeriod: ThresholdPeriod, defaultLimitBytes: number): Promise<void> {
    const explicit = new Map(getDeviceThresholds(this.db).map((row) => [row.mac, row]));
    const devices = devicesForThresholds(this.db);
    for (const device of devices) {
      const override = explicit.get(device.mac);
      const enabled = override ? override.enabled : defaultLimitBytes > 0;
      const limitBytes = override ? override.limitBytes : defaultLimitBytes;
      const period = override ? override.period : defaultPeriod;
      if (!enabled || limitBytes <= 0) continue;
      const used = deviceDownloadForPeriod(this.db, period, device.mac);
      if (used < limitBytes) continue;
      const stateKey = thresholdStateKey('device_download_threshold', period, device.mac, limitBytes, now);
      if (!markNotificationState(this.db, stateKey, used, now)) continue;
      const payload = {
        rule: 'device_download_threshold',
        period,
        mac: device.mac,
        label: device.label,
        bytes_down: used,
        threshold_bytes: limitBytes,
        message: `${device.label} crossed ${formatBytes(limitBytes)} (${formatBytes(used)} used).`,
      };
      const alert = insertAlertIfAllowed(this.db, 'device_download_threshold', device.mac, payload, now);
      if (!alert.inserted) continue;
      const result = await sendDownloadThresholdPush(this.db, {
        kind: 'device_download_threshold',
        mac: device.mac,
        label: device.label,
        period,
        bytes: used,
        thresholdBytes: limitBytes,
      });
      log.warn('device-download threshold push result', { mac: device.mac, period, limitBytes, used, ...result });
    }
  }
}

function devicesForThresholds(db: Database.Database): DeviceUsage[] {
  const rows = db.prepare(
    `SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label
     FROM devices
     ORDER BY label COLLATE NOCASE`,
  ).all() as Array<{ mac: string; label: string | null }>;
  return rows.map((row) => ({
    mac: normalizeMac(row.mac),
    label: row.label || row.mac,
    bytes_down: 0,
  })).filter((row) => row.mac);
}

function totalDownloadForPeriod(db: Database.Database, period: ThresholdPeriod): number {
  if (period === 'all') {
    const rows = db.prepare(`
      WITH rollups AS (${bytesSinceSql(0).sql}),
      sessions AS (
        SELECT mac, SUM(bytes_down) AS bd
        FROM device_sessions
        GROUP BY mac
      )
      SELECT COALESCE(SUM(MAX(COALESCE(s.bd, 0), COALESCE(r.bd, 0))), 0) AS bytes_down
      FROM devices d
      LEFT JOIN rollups r ON r.mac = d.mac
      LEFT JOIN sessions s ON s.mac = d.mac
    `).get(...bytesSinceSql(0).params) as { bytes_down: number };
    return Number(rows.bytes_down ?? 0);
  }
  const since = periodStart(period);
  const query = bytesSinceSql(since);
  const row = db.prepare(`SELECT COALESCE(SUM(bytes_down), 0) AS bytes_down FROM (${query.sql})`)
    .get(...query.params) as { bytes_down: number };
  return Number(row.bytes_down ?? 0);
}

function deviceDownloadForPeriod(db: Database.Database, period: ThresholdPeriod, mac: string): number {
  if (period === 'all') {
    const rollups = bytesSinceSql(0, mac);
    const row = db.prepare(`
      WITH rollups AS (${rollups.sql}),
      sessions AS (SELECT SUM(bytes_down) AS bd FROM device_sessions WHERE mac = ?)
      SELECT MAX(COALESCE((SELECT bd FROM sessions), 0), COALESCE((SELECT SUM(bytes_down) FROM rollups), 0)) AS bytes_down
    `).get(...rollups.params, mac) as { bytes_down: number };
    return Number(row.bytes_down ?? 0);
  }
  const query = bytesSinceSql(periodStart(period), mac);
  const row = db.prepare(`SELECT COALESCE(SUM(bytes_down), 0) AS bytes_down FROM (${query.sql})`)
    .get(...query.params) as { bytes_down: number };
  return Number(row.bytes_down ?? 0);
}

function periodStart(period: ThresholdPeriod): number {
  const now = Date.now();
  if (period === 'week') return now - 7 * DAY;
  if (period === 'month') return now - 30 * DAY;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function thresholdStateKey(kind: string, period: ThresholdPeriod, mac: string | null, thresholdBytes: number, now: number): string {
  const bucket = period === 'all'
    ? 'all'
    : period === 'month'
      ? monthKey(now)
      : dayKey(now);
  return `${kind}|${period}|${bucket}|${mac || 'all'}|${thresholdBytes}`;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function bytesSinceSql(since: number, mac?: string): { sql: string; params: unknown[] } {
  const now = Date.now();
  const startOfHour = Math.floor(now / HOUR) * HOUR;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const startOfDay = d.getTime();
  const month = new Date(now);
  month.setDate(1);
  month.setHours(0, 0, 0, 0);
  const startOfMonth = month.getTime();

  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (table: string, from: number, to?: number) => {
    const where = ['bucket_ts >= ?'];
    params.push(from);
    if (to !== undefined) {
      where.push('bucket_ts < ?');
      params.push(to);
    }
    if (mac) {
      where.push('mac = ?');
      params.push(mac);
    }
    parts.push(`SELECT mac, bytes_down FROM ${table} WHERE ${where.join(' AND ')}`);
  };

  if (since >= startOfHour) {
    add('traffic_5min', since);
    return groupedBytesSql(parts, params);
  }
  if (since >= startOfDay) {
    add('traffic_5min', startOfHour);
    add('traffic_hour', since, startOfHour);
    return groupedBytesSql(parts, params);
  }
  if (since >= startOfMonth) {
    add('traffic_5min', startOfHour);
    add('traffic_hour', startOfDay, startOfHour);
    add('traffic_day', since, startOfDay);
    return groupedBytesSql(parts, params);
  }
  add('traffic_5min', startOfHour);
  add('traffic_hour', startOfDay, startOfHour);
  add('traffic_day', startOfMonth, startOfDay);
  add('traffic_month', since, startOfMonth);
  return groupedBytesSql(parts, params);
}

function groupedBytesSql(parts: string[], params: unknown[]): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT mac, SUM(bytes_down) AS bytes_down FROM (${parts.join(' UNION ALL ')}) GROUP BY mac`,
    params,
  };
}

function normalizeMac(value: unknown): string {
  if (typeof value !== 'string') return '';
  const mac = value.trim().toUpperCase();
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? mac : '';
}

function formatBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 4).toFixed(2)} TB`;
}
