import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { getNetworkControlSummary } from '../../../lib/queries';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

const MAX_SPEED_LIMIT_KBS = 128_000;
const CONTROL_BASE = `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const url = new URL(req.url);
  if (url.searchParams.get('refresh') === '1') {
    try {
      await fetch(`${CONTROL_BASE}/device-control`, { signal: AbortSignal.timeout(6000) });
    } catch {
      // Fall back to cached SQLite summary if poller control plane is momentarily busy
    }
  }

  const summary = getNetworkControlSummary();
  return NextResponse.json({ ok: true, ...summary });
}

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: {
    enabled?: unknown;
    auto_reserve?: unknown;
    download_limit_kbs?: unknown;
    upload_limit_kbs?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const current = getNetworkControlSummary().auto_qos_policy;
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : current.enabled;
  const autoReserve = body.auto_reserve !== undefined ? Boolean(body.auto_reserve) : current.auto_reserve;
  const dl = body.download_limit_kbs !== undefined
    ? Math.round(Number(body.download_limit_kbs))
    : current.download_limit_kbs;
  const ul = body.upload_limit_kbs !== undefined
    ? Math.round(Number(body.upload_limit_kbs))
    : current.upload_limit_kbs;

  if (
    !Number.isFinite(dl) || dl < 0 || dl > MAX_SPEED_LIMIT_KBS ||
    !Number.isFinite(ul) || ul < 0 || ul > MAX_SPEED_LIMIT_KBS
  ) {
    return NextResponse.json(
      { ok: false, error: `Speed limits must be integers between 0 and ${MAX_SPEED_LIMIT_KBS} KB/s` },
      { status: 400 },
    );
  }

  // Persist directly in shared SQLite `kv` AND notify poller control server if reachable
  const conn = db();
  const upsert = conn.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  conn.transaction(() => {
    upsert.run('router.auto_qos_new_devices.enabled', enabled ? '1' : '0');
    upsert.run('router.auto_qos_new_devices.auto_reserve', autoReserve ? '1' : '0');
    upsert.run('router.auto_qos_new_devices.download_kbs', String(dl));
    upsert.run('router.auto_qos_new_devices.upload_kbs', String(ul));
  })();

  try {
    await fetch(`${CONTROL_BASE}/auto-qos-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, autoReserve, downloadLimitKBs: dl, uploadLimitKBs: ul }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Poller reads SQLite `kv` on every new-device event, so SQLite write is already authoritative
  }

  const summary = getNetworkControlSummary();
  return NextResponse.json({ ok: true, ...summary });
}
