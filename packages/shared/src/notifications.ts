import type Database from 'better-sqlite3';

export const NOTIFICATION_TYPES = [
  {
    key: 'new_device',
    label: 'New devices',
    description: 'New MAC address appears on the network.',
  },
  {
    key: 'nsfw',
    label: 'Adult-content visits',
    description: 'Router log shows adult, webcam, hentai, dating, or similar domains.',
  },
  {
    key: 'security',
    label: 'Security heuristics',
    description: 'High connections, high upload, cloned hostnames, random MAC spikes, or subnet anomalies.',
  },
  {
    key: 'attack',
    label: 'Router attacks',
    description: 'ARP / DDoS attacks detected by the router log.',
  },
  {
    key: 'outage',
    label: 'Outages',
    description: 'Router unreachable or authentication failures.',
  },
  {
    key: 'reboot',
    label: 'Reboots',
    description: 'Router uptime reset detected.',
  },
  {
    key: 'total_download_threshold',
    label: 'Total download limit',
    description: 'All devices combined cross a configured download threshold.',
  },
  {
    key: 'device_download_threshold',
    label: 'Device download limit',
    description: 'One device crosses its configured download threshold.',
  },
  {
    key: 'test',
    label: 'Test notifications',
    description: 'Manual test push from Settings.',
  },
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]['key'];
export type ThresholdPeriod = 'today' | 'week' | 'month' | 'all';

export interface NotificationTypeState {
  key: NotificationType;
  label: string;
  description: string;
  enabled: boolean;
}

export interface ThresholdConfig {
  totalEnabled: boolean;
  totalLimitBytes: number;
  totalPeriod: ThresholdPeriod;
  deviceEnabled: boolean;
  deviceDefaultLimitBytes: number;
  deviceDefaultPeriod: ThresholdPeriod;
}

export interface DeviceThreshold {
  mac: string;
  label: string;
  enabled: boolean;
  limitBytes: number;
  period: ThresholdPeriod;
  updatedAt: number;
}

export interface InsertAlertResult {
  inserted: boolean;
  id: number | null;
  disabled: boolean;
  suppressed: boolean;
  suppressionKey: string;
}

const ENABLED_PREFIX = 'notification_enabled_';
const THRESHOLD_TOTAL_ENABLED = 'notification_total_download_enabled';
const THRESHOLD_TOTAL_LIMIT = 'notification_total_download_limit_bytes';
const THRESHOLD_TOTAL_PERIOD = 'notification_total_download_period';
const THRESHOLD_DEVICE_ENABLED = 'notification_device_download_enabled';
const THRESHOLD_DEVICE_DEFAULT_LIMIT = 'notification_device_download_default_limit_bytes';
const THRESHOLD_DEVICE_DEFAULT_PERIOD = 'notification_device_download_default_period';

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && NOTIFICATION_TYPES.some((t) => t.key === value);
}

export function notificationTypeForAlertKind(kind: string): NotificationType | null {
  switch (kind) {
    case 'new_device':
    case 'nsfw':
    case 'security':
    case 'attack':
    case 'outage':
    case 'reboot':
    case 'total_download_threshold':
    case 'device_download_threshold':
      return kind;
    default:
      return null;
  }
}

export function getNotificationTypes(db: Database.Database): NotificationTypeState[] {
  return NOTIFICATION_TYPES.map((type) => ({
    ...type,
    enabled: isNotificationEnabled(db, type.key),
  }));
}

export function isNotificationEnabled(db: Database.Database, type: NotificationType | string | null | undefined): boolean {
  if (!type || !isNotificationType(type)) return true;
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`${ENABLED_PREFIX}${type}`) as { value?: string } | undefined;
    if (!row) return true;
    return normalizeBoolean(row.value, true);
  } catch {
    return true;
  }
}

export function setNotificationEnabled(db: Database.Database, type: NotificationType, enabled: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`${ENABLED_PREFIX}${type}`, enabled ? 'on' : 'off');
}

export function getThresholdConfig(db: Database.Database): ThresholdConfig {
  return {
    totalEnabled: getSettingBoolean(db, THRESHOLD_TOTAL_ENABLED, false),
    totalLimitBytes: getSettingInt(db, THRESHOLD_TOTAL_LIMIT, 0),
    totalPeriod: getSettingPeriod(db, THRESHOLD_TOTAL_PERIOD, 'today'),
    deviceEnabled: getSettingBoolean(db, THRESHOLD_DEVICE_ENABLED, false),
    deviceDefaultLimitBytes: getSettingInt(db, THRESHOLD_DEVICE_DEFAULT_LIMIT, 0),
    deviceDefaultPeriod: getSettingPeriod(db, THRESHOLD_DEVICE_DEFAULT_PERIOD, 'today'),
  };
}

export function updateThresholdConfig(db: Database.Database, patch: Partial<ThresholdConfig>): ThresholdConfig {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const txn = db.transaction(() => {
    if (typeof patch.totalEnabled === 'boolean') upsert.run(THRESHOLD_TOTAL_ENABLED, patch.totalEnabled ? 'on' : 'off');
    if (typeof patch.totalLimitBytes === 'number') upsert.run(THRESHOLD_TOTAL_LIMIT, String(safeBytes(patch.totalLimitBytes)));
    if (patch.totalPeriod) upsert.run(THRESHOLD_TOTAL_PERIOD, normalizePeriod(patch.totalPeriod));
    if (typeof patch.deviceEnabled === 'boolean') upsert.run(THRESHOLD_DEVICE_ENABLED, patch.deviceEnabled ? 'on' : 'off');
    if (typeof patch.deviceDefaultLimitBytes === 'number') upsert.run(THRESHOLD_DEVICE_DEFAULT_LIMIT, String(safeBytes(patch.deviceDefaultLimitBytes)));
    if (patch.deviceDefaultPeriod) upsert.run(THRESHOLD_DEVICE_DEFAULT_PERIOD, normalizePeriod(patch.deviceDefaultPeriod));
  });
  txn();
  return getThresholdConfig(db);
}

export function getDeviceThresholds(db: Database.Database): DeviceThreshold[] {
  const rows = db.prepare(
    `SELECT t.mac,
            COALESCE(d.custom_label, d.router_remark, d.hostname, t.mac) AS label,
            t.enabled, t.download_limit_bytes, t.period, t.updated_at
     FROM device_notification_thresholds t
     LEFT JOIN devices d ON d.mac = t.mac
     ORDER BY label COLLATE NOCASE`,
  ).all() as Array<{
    mac: string;
    label: string | null;
    enabled: number;
    download_limit_bytes: number;
    period: string;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    mac: normalizeMac(row.mac),
    label: trimText(row.label, 120) || normalizeMac(row.mac),
    enabled: Number(row.enabled) === 1,
    limitBytes: safeBytes(Number(row.download_limit_bytes)),
    period: normalizePeriod(row.period),
    updatedAt: normalizeTimestamp(row.updated_at),
  }));
}

export function upsertDeviceThreshold(
  db: Database.Database,
  input: { mac: string; enabled: boolean; limitBytes: number; period: ThresholdPeriod | string },
): DeviceThreshold {
  const mac = normalizeMac(input.mac);
  if (!mac) throw new Error('invalid mac');
  const now = Date.now();
  db.prepare(
    `INSERT INTO device_notification_thresholds (mac, enabled, download_limit_bytes, period, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mac) DO UPDATE SET
       enabled = excluded.enabled,
       download_limit_bytes = excluded.download_limit_bytes,
       period = excluded.period,
       updated_at = excluded.updated_at`,
  ).run(mac, input.enabled ? 1 : 0, safeBytes(input.limitBytes), normalizePeriod(input.period), now, now);
  const hit = getDeviceThresholds(db).find((row) => row.mac === mac);
  if (!hit) throw new Error('device threshold save failed');
  return hit;
}

export function deleteDeviceThreshold(db: Database.Database, macInput: string): boolean {
  const mac = normalizeMac(macInput);
  if (!mac) return false;
  return db.prepare(`DELETE FROM device_notification_thresholds WHERE mac = ?`).run(mac).changes > 0;
}

export function insertAlertIfAllowed(
  db: Database.Database,
  kind: string,
  macInput: string | null,
  payload: Record<string, unknown>,
  createdAt: number,
): InsertAlertResult {
  const type = notificationTypeForAlertKind(kind);
  const mac = normalizeMac(macInput ?? '');
  const suppressionKey = buildAlertSuppressionKey(kind, mac || null, payload);
  if (type && !isNotificationEnabled(db, type)) {
    return { inserted: false, id: null, disabled: true, suppressed: false, suppressionKey };
  }
  if (isSuppressionKeyActive(db, suppressionKey)) {
    return { inserted: false, id: null, disabled: false, suppressed: true, suppressionKey };
  }
  const result = db.prepare(
    `INSERT INTO alerts (kind, mac, payload, created_at) VALUES (?, ?, ?, ?)`,
  ).run(kind, mac || null, JSON.stringify(payload), createdAt);
  return {
    inserted: result.changes > 0,
    id: Number(result.lastInsertRowid || 0) || null,
    disabled: false,
    suppressed: false,
    suppressionKey,
  };
}

export function suppressAlertFuture(db: Database.Database, alertId: number): {
  ok: true;
  suppressionKey: string;
  kind: string;
  mac: string | null;
} | { ok: false; error: string } {
  const id = Math.trunc(Number(alertId));
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'invalid alert id' };
  const row = db.prepare(`SELECT id, kind, mac, payload FROM alerts WHERE id = ?`).get(id) as
    | { id: number; kind: string; mac: string | null; payload: string | null }
    | undefined;
  if (!row) return { ok: false, error: 'alert not found' };
  const payload = parsePayload(row.payload);
  const mac = normalizeMac(row.mac ?? '') || null;
  const suppressionKey = buildAlertSuppressionKey(row.kind, mac, payload);
  const now = Date.now();
  db.prepare(
    `INSERT INTO notification_suppressions (
       suppression_key, kind, rule, mac, label, source_alert_id, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(suppression_key) DO UPDATE SET
       updated_at = excluded.updated_at,
       source_alert_id = excluded.source_alert_id`,
  ).run(
    suppressionKey,
    row.kind,
    trimText(payload.rule ?? payload.kind ?? payload.reason ?? payload.period, 80) || null,
    mac,
    suppressionLabel(row.kind, mac, payload),
    id,
    now,
    now,
  );
  db.prepare(`UPDATE alerts SET dismissed_at = COALESCE(dismissed_at, ?) WHERE id = ?`).run(now, id);
  return { ok: true, suppressionKey, kind: row.kind, mac };
}

export function isAlertSuppressed(
  db: Database.Database,
  kind: string,
  mac: string | null,
  payload: Record<string, unknown>,
): boolean {
  return isSuppressionKeyActive(db, buildAlertSuppressionKey(kind, mac, payload));
}

export function isSuppressionKeyActive(db: Database.Database, suppressionKey: string): boolean {
  if (!suppressionKey) return false;
  try {
    const row = db.prepare(`SELECT suppression_key FROM notification_suppressions WHERE suppression_key = ?`).get(suppressionKey);
    return Boolean(row);
  } catch {
    return false;
  }
}

export function buildAlertSuppressionKey(
  kind: string,
  macInput: string | null,
  payload: Record<string, unknown> = {},
): string {
  const mac = normalizeMac(macInput ?? '') || normalizeMac(payload.mac) || normalizeMac(payload.source_mac);
  switch (kind) {
    case 'new_device':
      return `new_device|mac:${mac || '*'}`;
    case 'nsfw': {
      const source = mac || trimText(payload.ip ?? payload.source_ip, 80) || '*';
      const domain = trimText(payload.domain, 120) || '*';
      return `nsfw|source:${source}|domain:${domain}`;
    }
    case 'security':
      return `security|rule:${trimText(payload.rule, 80) || '*'}|mac:${mac || '*'}`;
    case 'attack':
      return `attack|kind:${trimText(payload.kind ?? payload.attack_kind, 80) || '*'}|mac:${mac || normalizeMac(payload.attacker_mac) || '*'}`;
    case 'outage':
      return `outage|reason:${trimText(payload.reason, 80) || '*'}`;
    case 'reboot':
      return 'reboot|router';
    case 'total_download_threshold':
      return `total_download_threshold|period:${trimText(payload.period, 40) || '*'}`;
    case 'device_download_threshold':
      return `device_download_threshold|period:${trimText(payload.period, 40) || '*'}|mac:${mac || '*'}`;
    default:
      return `${kind}|rule:${trimText(payload.rule ?? payload.kind, 80) || '*'}|mac:${mac || '*'}`;
  }
}

export function markNotificationState(db: Database.Database, key: string, value: number, now = Date.now()): boolean {
  const clean = trimText(key, 240);
  if (!clean) return false;
  const result = db.prepare(
    `INSERT OR IGNORE INTO notification_state (state_key, last_triggered_at, value)
     VALUES (?, ?, ?)`,
  ).run(clean, now, Math.max(0, Math.trunc(value)));
  return result.changes > 0;
}

export function normalizePeriod(value: unknown): ThresholdPeriod {
  if (value === 'week' || value === 'month' || value === 'all') return value;
  return 'today';
}

function getSettingBoolean(db: Database.Database, key: string, fallback: boolean): boolean {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
    if (!row) return fallback;
    return normalizeBoolean(row.value, fallback);
  } catch {
    return fallback;
  }
}

function getSettingInt(db: Database.Database, key: string, fallback: number): number {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
    if (!row) return fallback;
    return safeBytes(Number(row.value));
  } catch {
    return fallback;
  }
}

function getSettingPeriod(db: Database.Database, key: string, fallback: ThresholdPeriod): ThresholdPeriod {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
    if (!row) return fallback;
    return normalizePeriod(row.value);
  } catch {
    return fallback;
  }
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'on' || v === 'true' || v === 'yes') return true;
    if (v === 'off' || v === 'false' || v === 'no') return false;
  }
  return fallback;
}

function suppressionLabel(kind: string, mac: string | null, payload: Record<string, unknown>): string {
  const rule = trimText(payload.rule ?? payload.kind ?? payload.reason ?? payload.domain ?? payload.period, 80);
  return [kind, rule, mac].filter(Boolean).join(' / ').slice(0, 180);
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), 1024 ** 5);
}

function normalizeTimestamp(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalizeMac(value: unknown): string {
  if (typeof value !== 'string') return '';
  const mac = value.trim().toUpperCase();
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? mac : '';
}

function trimText(value: unknown, limit = 120): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, limit);
}
