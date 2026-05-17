import { NextResponse } from 'next/server';
import {
  deleteDeviceThreshold,
  getDb,
  getDeviceThresholds,
  getNotificationTypes,
  getThresholdConfig,
  isNotificationType,
  normalizePeriod,
  setNotificationEnabled,
  updateThresholdConfig,
  upsertDeviceThreshold,
} from '@tenda/shared';
import { ensureWebMigrations } from '../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureWebMigrations();
  const db = getDb();
  const devices = db.prepare(
    `SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label, category
     FROM devices
     ORDER BY label COLLATE NOCASE`,
  ).all() as Array<{ mac: string; label: string | null; category: string | null }>;

  return NextResponse.json({
    ok: true,
    types: getNotificationTypes(db),
    thresholds: getThresholdConfig(db),
    deviceThresholds: getDeviceThresholds(db),
    devices: devices.map((d) => ({ mac: d.mac, label: d.label || d.mac, category: d.category })),
  });
}

export async function PATCH(req: Request) {
  ensureWebMigrations();
  const db = getDb();
  const body = await req.json();

  if (body?.action === 'set_type') {
    if (!isNotificationType(body.type) || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'invalid notification type' }, { status: 400 });
    }
    setNotificationEnabled(db, body.type, body.enabled);
    return NextResponse.json({ ok: true, types: getNotificationTypes(db) });
  }

  if (body?.action === 'save_thresholds') {
    const thresholds = updateThresholdConfig(db, {
      totalEnabled: Boolean(body.totalEnabled),
      totalLimitBytes: safeBytes(body.totalLimitBytes),
      totalPeriod: normalizePeriod(body.totalPeriod),
      deviceEnabled: Boolean(body.deviceEnabled),
      deviceDefaultLimitBytes: safeBytes(body.deviceDefaultLimitBytes),
      deviceDefaultPeriod: normalizePeriod(body.deviceDefaultPeriod),
    });
    return NextResponse.json({ ok: true, thresholds });
  }

  if (body?.action === 'upsert_device_threshold') {
    try {
      const threshold = upsertDeviceThreshold(db, {
        mac: String(body.mac ?? ''),
        enabled: Boolean(body.enabled),
        limitBytes: safeBytes(body.limitBytes),
        period: normalizePeriod(body.period),
      });
      return NextResponse.json({ ok: true, threshold, deviceThresholds: getDeviceThresholds(db) });
    } catch (error) {
      return NextResponse.json({ ok: false, error: String(error) }, { status: 400 });
    }
  }

  if (body?.action === 'delete_device_threshold') {
    const deleted = deleteDeviceThreshold(db, String(body.mac ?? ''));
    return NextResponse.json({ ok: true, deleted, deviceThresholds: getDeviceThresholds(db) });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}

function safeBytes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.trunc(n), 1024 ** 5);
}
