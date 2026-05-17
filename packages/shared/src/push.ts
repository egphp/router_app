import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import webpush from 'web-push';
import {
  buildAlertSuppressionKey,
  isNotificationEnabled,
  isSuppressionKeyActive,
  type NotificationType,
} from './notifications.js';

export interface PushSubscriptionInput {
  endpoint?: unknown;
  expirationTime?: unknown;
  keys?: {
    p256dh?: unknown;
    auth?: unknown;
  };
}

export interface PushClientMetadata {
  clientPlatform?: string | null;
  clientUserAgent?: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  image?: string;
}

export interface NewDevicePushInput {
  mac: string;
  hostname?: string | null;
  ip?: string | null;
  vendor?: string | null;
  category?: string | null;
}

export interface NsfwPushInput {
  mac?: string | null;
  ip?: string | null;
  domain: string;
  category: string;
}

export interface SecurityPushInput {
  rule: string;
  severity?: string | null;
  mac?: string | null;
  message: string;
  ip?: string | null;
}

export interface AttackPushInput {
  mac?: string | null;
  ip?: string | null;
  kind?: string | null;
  count?: number | null;
  message?: string | null;
}

export interface OutagePushInput {
  kind: 'outage' | 'reboot';
  reason?: string | null;
  notes?: string | null;
  startedAt?: number | null;
  uptimeBefore?: number | null;
  uptimeAfter?: number | null;
}

export interface DownloadThresholdPushInput {
  kind: 'total_download_threshold' | 'device_download_threshold';
  mac?: string | null;
  label?: string | null;
  period: string;
  bytes: number;
  thresholdBytes: number;
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
}

interface PushSubscriptionStatusRow {
  endpoint: string;
  status: string;
  expiration_time: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
}

export interface PushSubscriptionHealth {
  ok: true;
  known: boolean;
  status: string | null;
  needsRefresh: boolean;
  reason: 'not_found' | 'inactive' | 'expiring_soon' | 'send_failed' | null;
  expirationTime: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

export interface PushDeliveryOverview {
  tag: string | null;
  status: string;
  error: string | null;
  createdAt: number;
}

export interface PushSubscriptionOverview {
  id: number;
  endpointHash: string;
  endpointHost: string;
  endpointPreview: string;
  status: string;
  expirationTime: number | null;
  createdAt: number;
  updatedAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  clientPlatform: string | null;
  clientUserAgent: string | null;
  needsRefresh: boolean;
  refreshReason: PushSubscriptionHealth['reason'];
  recentDeliveries: PushDeliveryOverview[];
}

export interface PushSubscriptionsOverview {
  total: number;
  active: number;
  expired: number;
  needsRefresh: number;
  failing: number;
  subscriptions: PushSubscriptionOverview[];
}

export interface SendPushOptions {
  notificationType?: NotificationType;
  suppressionKey?: string;
}

const VAPID_PUBLIC_KEY = 'push_vapid_public_key';
const VAPID_PRIVATE_KEY = 'push_vapid_private_key';
const VAPID_SUBJECT_KEY = 'push_vapid_subject';
const DEFAULT_VAPID_SUBJECT = 'mailto:admin@tv-eg.com';
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const PUSH_REFRESH_WINDOW_MS = 30 * 24 * 3600 * 1000;

export function ensureVapidKeys(db: Database.Database): { publicKey: string; privateKey: string; subject: string } {
  const get = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  let publicKey = rowValue(get.get(VAPID_PUBLIC_KEY));
  let privateKey = rowValue(get.get(VAPID_PRIVATE_KEY));
  let subject = normalizeVapidSubject(rowValue(get.get(VAPID_SUBJECT_KEY)));

  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    const txn = db.transaction(() => {
      upsert.run(VAPID_PUBLIC_KEY, publicKey);
      upsert.run(VAPID_PRIVATE_KEY, privateKey);
      upsert.run(VAPID_SUBJECT_KEY, subject);
    });
    txn();
  } else if (subject !== rowValue(get.get(VAPID_SUBJECT_KEY))) {
    upsert.run(VAPID_SUBJECT_KEY, subject);
  }

  return { publicKey, privateKey, subject };
}

export function getVapidPublicKey(db: Database.Database): string {
  return ensureVapidKeys(db).publicKey;
}

export function savePushSubscription(
  db: Database.Database,
  input: PushSubscriptionInput,
  metadata: PushClientMetadata = {},
): { ok: true; endpoint: string } | { ok: false; error: string } {
  const normalized = normalizeSubscription(input);
  if (!normalized.ok) return normalized;

  const now = Date.now();
  db.prepare(
    `INSERT INTO push_subscriptions (
       endpoint, p256dh, auth, expiration_time, status, created_at, updated_at,
       last_error, client_platform, client_user_agent
     )
     VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       expiration_time = excluded.expiration_time,
       status = 'active',
       updated_at = excluded.updated_at,
       last_error = NULL,
       last_failure_at = NULL,
       client_platform = excluded.client_platform,
       client_user_agent = excluded.client_user_agent`,
  ).run(
    normalized.endpoint,
    normalized.p256dh,
    normalized.auth,
    normalized.expirationTime,
    now,
    now,
    trimText(metadata.clientPlatform, 80),
    trimText(metadata.clientUserAgent, 240),
  );

  return { ok: true, endpoint: normalized.endpoint };
}

export function getPushSubscriptionHealth(db: Database.Database, endpoint: unknown): PushSubscriptionHealth | { ok: false; error: string } {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return { ok: false, error: 'invalid endpoint' };
  }

  const row = db.prepare(
    `SELECT endpoint, status, expiration_time, last_success_at, last_failure_at, last_error
     FROM push_subscriptions
     WHERE endpoint = ?`,
  ).get(endpoint) as PushSubscriptionStatusRow | undefined;

  if (!row) {
    return {
      ok: true,
      known: false,
      status: null,
      needsRefresh: false,
      reason: 'not_found',
      expirationTime: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    };
  }

  const now = Date.now();
  const expirationTime = normalizeExpiration(row.expiration_time);
  const lastSuccessAt = normalizeOptionalTimestamp(row.last_success_at);
  const lastFailureAt = normalizeOptionalTimestamp(row.last_failure_at);
  let reason: PushSubscriptionHealth['reason'] = null;

  if (row.status !== 'active') {
    reason = 'inactive';
  } else if (expirationTime !== null && expirationTime - now < PUSH_REFRESH_WINDOW_MS) {
    reason = 'expiring_soon';
  } else if (lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt)) {
    reason = 'send_failed';
  }

  return {
    ok: true,
    known: true,
    status: row.status,
    needsRefresh: reason !== null,
    reason,
    expirationTime,
    lastSuccessAt,
    lastFailureAt,
    lastError: trimText(row.last_error, 500) || null,
  };
}

export function getPushSubscriptionsOverview(db: Database.Database, limit = 100): PushSubscriptionsOverview {
  const rows = db.prepare(
    `SELECT id, endpoint, status, expiration_time, created_at, updated_at,
            last_success_at, last_failure_at, last_error, client_platform, client_user_agent
     FROM push_subscriptions
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(Math.max(1, Math.min(500, Math.trunc(limit)))) as Array<{
    id: number;
    endpoint: string;
    status: string;
    expiration_time: number | null;
    created_at: number;
    updated_at: number;
    last_success_at: number | null;
    last_failure_at: number | null;
    last_error: string | null;
    client_platform: string | null;
    client_user_agent: string | null;
  }>;

  let active = 0;
  let expired = 0;
  let needsRefresh = 0;
  let failing = 0;

  const subscriptions = rows.map((row) => {
    const health = getPushSubscriptionHealth(db, row.endpoint);
    const endpointHash = hashEndpoint(row.endpoint);
    const recentDeliveries = db.prepare(
      `SELECT tag, status, error, created_at
       FROM push_delivery_log
       WHERE endpoint_hash = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    ).all(endpointHash) as Array<{ tag: string | null; status: string; error: string | null; created_at: number }>;

    const isActive = row.status === 'active';
    const refresh = health.ok ? health.needsRefresh : false;
    const reason = health.ok ? health.reason : null;
    if (isActive) active += 1;
    if (row.status === 'expired') expired += 1;
    if (isActive && refresh) needsRefresh += 1;
    if (isActive && reason === 'send_failed') failing += 1;

    return {
      id: Number(row.id),
      endpointHash,
      ...describeEndpoint(row.endpoint),
      status: row.status,
      expirationTime: normalizeExpiration(row.expiration_time),
      createdAt: normalizeOptionalTimestamp(row.created_at) ?? 0,
      updatedAt: normalizeOptionalTimestamp(row.updated_at) ?? 0,
      lastSuccessAt: normalizeOptionalTimestamp(row.last_success_at),
      lastFailureAt: normalizeOptionalTimestamp(row.last_failure_at),
      lastError: trimText(row.last_error, 500) || null,
      clientPlatform: trimText(row.client_platform, 80) || null,
      clientUserAgent: trimText(row.client_user_agent, 240) || null,
      needsRefresh: refresh,
      refreshReason: reason,
      recentDeliveries: recentDeliveries.map((delivery) => ({
        tag: delivery.tag,
        status: delivery.status,
        error: trimText(delivery.error, 500) || null,
        createdAt: normalizeOptionalTimestamp(delivery.created_at) ?? 0,
      })),
    };
  });

  return {
    total: rows.length,
    active,
    expired,
    needsRefresh,
    failing,
    subscriptions,
  };
}

export function expirePushSubscription(db: Database.Database, endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return false;
  const res = db.prepare(
    `UPDATE push_subscriptions
     SET status = 'expired', updated_at = ?, last_error = COALESCE(last_error, 'client unsubscribe')
     WHERE endpoint = ?`,
  ).run(Date.now(), endpoint);
  return res.changes > 0;
}

export async function sendNewDevicePush(
  db: Database.Database,
  device: NewDevicePushInput,
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const payload = buildNewDevicePushPayload(device);
  if (!payload) return { sent: 0, failed: 0, expired: 0, skipped: 1 };
  return sendPushToAll(db, payload, {
    notificationType: 'new_device',
    suppressionKey: buildAlertSuppressionKey('new_device', device.mac, { mac: device.mac }),
  });
}

export function buildNewDevicePushPayload(device: NewDevicePushInput): PushPayload | null {
  const mac = normalizeMac(device.mac);
  if (!mac) return null;
  const name = trimText(device.hostname, 80) || trimText(device.vendor, 80) || 'Unknown device';
  const ip = trimText(device.ip, 80) || 'no IP';
  const details = [name, ip, mac, trimText(device.vendor, 80), trimText(device.category, 40)]
    .filter((part, index, parts) => part && parts.indexOf(part) === index);
  return {
    title: 'جهاز جديد دخل الشبكة',
    body: details.join(' • '),
    url: `/devices/${encodeURIComponent(mac)}`,
    tag: `new-device-${mac}`,
    icon: '/icon-192.png',
  };
}

export async function sendNsfwPush(
  db: Database.Database,
  hit: NsfwPushInput,
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const payload = buildNsfwPushPayload(db, hit);
  return sendPushToAll(db, payload, {
    notificationType: 'nsfw',
    suppressionKey: buildAlertSuppressionKey('nsfw', hit.mac ?? null, {
      mac: hit.mac ?? null,
      ip: hit.ip ?? null,
      domain: hit.domain,
      category: hit.category,
    }),
  });
}

export function buildNsfwPushPayload(db: Database.Database, hit: NsfwPushInput): PushPayload {
  const mac = normalizeMac(hit.mac ?? '');
  const domain = trimText(hit.domain, 120) || 'adult site';
  const category = trimText(hit.category, 80) || 'adult';
  const ip = trimText(hit.ip, 80);
  const label = mac ? deviceLabel(db, mac) : (ip || 'Unknown device');
  const location = mac ? `/devices/${encodeURIComponent(mac)}` : '/security';
  const identity = mac ? mac : (ip || 'unknown source');
  return {
    title: 'تحذير محتوى جنسي',
    body: `${label} • ${domain} (${category}) • ${identity}`,
    url: location,
    tag: `nsfw-${mac || ip || 'unknown'}-${domain}`,
    icon: '/icon-192.png',
    image: undefined,
  };
}

export async function sendSecurityPush(
  db: Database.Database,
  input: SecurityPushInput,
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const mac = normalizeMac(input.mac ?? '');
  const label = mac ? deviceLabel(db, mac) : 'Network security';
  const rule = trimText(input.rule, 80) || 'security';
  const severity = trimText(input.severity, 40);
  return sendPushToAll(db, {
    title: severity === 'critical' ? 'تحذير أمني خطير' : 'تحذير أمني',
    body: [label, trimText(input.message, 140), input.ip ? `IP ${trimText(input.ip, 80)}` : '', rule].filter(Boolean).join(' • '),
    url: mac ? `/devices/${encodeURIComponent(mac)}` : '/security',
    tag: `security-${rule}-${mac || 'network'}`,
    icon: '/icon-192.png',
  }, {
    notificationType: 'security',
    suppressionKey: buildAlertSuppressionKey('security', mac || null, { rule }),
  });
}

export async function sendAttackPush(
  db: Database.Database,
  input: AttackPushInput,
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const mac = normalizeMac(input.mac ?? '');
  const label = mac ? deviceLabel(db, mac) : trimText(input.ip, 80) || 'Unknown attacker';
  const kind = trimText(input.kind, 80) || 'attack';
  const count = Number(input.count ?? 0);
  return sendPushToAll(db, {
    title: 'هجوم من الراوتر',
    body: [label, kind, count > 0 ? `${count} events` : '', trimText(input.message, 140)].filter(Boolean).join(' • '),
    url: mac ? `/devices/${encodeURIComponent(mac)}` : '/attacks',
    tag: `attack-${kind}-${mac || input.ip || 'unknown'}`,
    icon: '/icon-192.png',
  }, {
    notificationType: 'attack',
    suppressionKey: buildAlertSuppressionKey('attack', mac || null, { kind, attacker_mac: mac }),
  });
}

export async function sendOutagePush(
  db: Database.Database,
  input: OutagePushInput,
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const isReboot = input.kind === 'reboot';
  const payload = isReboot
    ? {
        title: 'الراوتر عمل Restart',
        body: `Uptime reset${input.uptimeBefore ? ` • before ${Math.round(input.uptimeBefore / 60)}m` : ''}${input.uptimeAfter ? ` • after ${Math.round(input.uptimeAfter / 60)}m` : ''}`,
        url: '/outages',
        tag: 'router-reboot',
        icon: '/icon-192.png',
      }
    : {
        title: 'انقطاع في الراوتر',
        body: [trimText(input.reason, 80) || 'unreachable', trimText(input.notes, 140)].filter(Boolean).join(' • '),
        url: '/outages',
        tag: `router-outage-${trimText(input.reason, 80) || 'unreachable'}`,
        icon: '/icon-192.png',
      };
  return sendPushToAll(db, payload, {
    notificationType: isReboot ? 'reboot' : 'outage',
    suppressionKey: buildAlertSuppressionKey(isReboot ? 'reboot' : 'outage', null, { reason: input.reason ?? null }),
  });
}

export async function sendDownloadThresholdPush(
  db: Database.Database,
  input: DownloadThresholdPushInput,
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  const mac = normalizeMac(input.mac ?? '');
  const label = trimText(input.label, 100) || (mac ? deviceLabel(db, mac) : 'All devices');
  return sendPushToAll(db, {
    title: input.kind === 'total_download_threshold' ? 'تخطي حد التحميل الكلي' : 'جهاز تخطى حد التحميل',
    body: `${label} • ${trimText(input.period, 40)} • ${formatBytesForPush(input.bytes)} / ${formatBytesForPush(input.thresholdBytes)}`,
    url: mac ? `/devices/${encodeURIComponent(mac)}` : '/analytics',
    tag: `${input.kind}-${trimText(input.period, 40)}-${mac || 'all'}`,
    icon: '/icon-192.png',
  }, {
    notificationType: input.kind,
    suppressionKey: buildAlertSuppressionKey(input.kind, mac || null, { period: input.period }),
  });
}

export async function sendPushToAll(
  db: Database.Database,
  payload: PushPayload,
  options: SendPushOptions = {},
): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
  if (options.notificationType && !isNotificationEnabled(db, options.notificationType)) {
    return { sent: 0, failed: 0, expired: 0, skipped: 1 };
  }
  if (options.suppressionKey && isSuppressionKeyActive(db, options.suppressionKey)) {
    return { sent: 0, failed: 0, expired: 0, skipped: 1 };
  }

  const keys = ensureVapidKeys(db);
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);

  const now = Date.now();
  const rows = db.prepare(
    `SELECT endpoint, p256dh, auth, expiration_time
     FROM push_subscriptions
     WHERE status = 'active'
       AND (expiration_time IS NULL OR expiration_time = 0 OR expiration_time > ?)`,
  ).all(now) as PushSubscriptionRow[];

  if (rows.length === 0) return { sent: 0, failed: 0, expired: 0, skipped: 0 };

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: cleanPushUrl(payload.url),
    tag: payload.tag || 'tenda-monitor',
    icon: cleanAssetUrl(payload.icon) || '/icon-192.png',
    image: cleanAssetUrl(payload.image),
  });

  let sent = 0;
  let failed = 0;
  let expired = 0;

  for (const row of rows) {
    const endpointHash = hashEndpoint(row.endpoint);
    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          expirationTime: row.expiration_time ?? null,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        body,
        { TTL: 24 * 3600 },
      );
      sent += 1;
      db.prepare(
        `UPDATE push_subscriptions
         SET last_success_at = ?, last_error = NULL, updated_at = ?
         WHERE endpoint = ?`,
      ).run(now, now, row.endpoint);
      insertDeliveryLog(db, endpointHash, payload.tag, 'sent', null, now);
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0);
      const message = pushErrorMessage(error);
      if (statusCode === 404 || statusCode === 410) {
        expired += 1;
        db.prepare(
          `UPDATE push_subscriptions
           SET status = 'expired', last_failure_at = ?, last_error = ?, updated_at = ?
           WHERE endpoint = ?`,
        ).run(now, message || `expired ${statusCode}`, now, row.endpoint);
        insertDeliveryLog(db, endpointHash, payload.tag, 'expired', message, now);
      } else {
        failed += 1;
        db.prepare(
          `UPDATE push_subscriptions
           SET last_failure_at = ?, last_error = ?, updated_at = ?
           WHERE endpoint = ?`,
        ).run(now, message || 'push send failed', now, row.endpoint);
        insertDeliveryLog(db, endpointHash, payload.tag, 'failed', message, now);
      }
    }
  }

  return { sent, failed, expired, skipped: 0 };
}

function normalizeSubscription(input: PushSubscriptionInput): (
  | { ok: true; endpoint: string; p256dh: string; auth: string; expirationTime: number | null }
  | { ok: false; error: string }
) {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const p256dh = typeof input.keys?.p256dh === 'string' ? input.keys.p256dh.trim() : '';
  const auth = typeof input.keys?.auth === 'string' ? input.keys.auth.trim() : '';
  if (!endpoint.startsWith('https://') || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return { ok: false, error: 'invalid endpoint' };
  }
  if (!p256dh || !auth || p256dh.length > MAX_KEY_LENGTH || auth.length > MAX_KEY_LENGTH) {
    return { ok: false, error: 'invalid keys' };
  }
  const expirationTime = normalizeExpiration(input.expirationTime);
  return { ok: true, endpoint, p256dh, auth, expirationTime };
}

function normalizeExpiration(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normalizeOptionalTimestamp(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function rowValue(row: unknown): string {
  if (!row || typeof row !== 'object' || !('value' in row)) return '';
  const value = (row as { value?: unknown }).value;
  return typeof value === 'string' ? value : '';
}

function normalizeVapidSubject(value: string): string {
  const subject = value.trim();
  if (!subject) return DEFAULT_VAPID_SUBJECT;
  const lower = subject.toLowerCase();
  if (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('[::1]') ||
    (!lower.startsWith('mailto:') && !lower.startsWith('https://'))
  ) {
    return DEFAULT_VAPID_SUBJECT;
  }
  return subject.slice(0, 240);
}

function pushErrorMessage(error: unknown): string {
  const base = trimText(error instanceof Error ? error.message : String(error), 240) || 'push send failed';
  const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0);
  const body = trimText((error as { body?: unknown }).body, 240);
  const reason = extractPushErrorReason(body);
  const detail = reason || body;
  if (statusCode > 0 && detail) return trimText(`${base} (${statusCode} ${detail})`, 500);
  if (statusCode > 0) return trimText(`${base} (${statusCode})`, 500);
  if (detail) return trimText(`${base} (${detail})`, 500);
  return base;
}

function extractPushErrorReason(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; error?: unknown };
    return trimText(parsed.reason, 160) || trimText(parsed.error, 160);
  } catch {
    return '';
  }
}

function cleanPushUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const parsed = new URL(value, 'https://tenda.local');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function cleanAssetUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  return value.slice(0, 240);
}

function trimText(value: unknown, limit = 120): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, limit);
}

function normalizeMac(value: unknown): string {
  if (typeof value !== 'string') return '';
  const mac = value.trim().toUpperCase();
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? mac : '';
}

function deviceLabel(db: Database.Database, mac: string): string {
  try {
    const row = db.prepare(
      `SELECT COALESCE(custom_label, hostname, router_remark, vendor, mac) AS label
       FROM devices WHERE mac = ?`,
    ).get(mac) as { label?: string } | undefined;
    return trimText(row?.label, 80) || mac;
  } catch {
    return mac;
  }
}

function hashEndpoint(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function describeEndpoint(endpoint: string): { endpointHost: string; endpointPreview: string } {
  try {
    const url = new URL(endpoint);
    const tail = endpoint.slice(-16);
    return {
      endpointHost: url.host,
      endpointPreview: `${url.host}/...${tail}`,
    };
  } catch {
    return {
      endpointHost: 'unknown',
      endpointPreview: `...${endpoint.slice(-16)}`,
    };
  }
}

function insertDeliveryLog(
  db: Database.Database,
  endpointHash: string,
  tag: string | undefined,
  status: string,
  error: string | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO push_delivery_log (endpoint_hash, tag, status, error, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(endpointHash, tag || null, status, error, now);
}

function formatBytesForPush(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 4).toFixed(2)} TB`;
}
