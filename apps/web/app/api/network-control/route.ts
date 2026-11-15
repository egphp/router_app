import net from 'node:net';
import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { getNetworkControlSummary } from '../../../lib/queries';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

const MAX_SPEED_LIMIT_KBS = 128_000;

function getControlBase(): string {
  return `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;
}

function isValidLanIp(ip: unknown): ip is string {
  if (typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  if (!net.isIPv4(trimmed)) return false;
  const [a, b] = trimmed.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b !== undefined && b >= 16 && b <= 31);
}

function isValidExternalSshPort(port: unknown): port is number {
  const n = typeof port === 'number' ? port : Number(port);
  if (!Number.isInteger(n)) return false;
  return n === 22 || (n >= 1024 && n <= 65535);
}

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const url = new URL(req.url);
  if (url.searchParams.get('refresh') === '1') {
    try {
      await fetch(`${getControlBase()}/device-control`, { signal: AbortSignal.timeout(8000) });
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
    action?: unknown;
    enabled?: unknown;
    auto_reserve?: unknown;
    download_limit_kbs?: unknown;
    upload_limit_kbs?: unknown;
    ssh_access?: {
      enabled?: unknown;
      target_ip?: unknown;
      external_port?: unknown;
      ssh_user?: unknown;
    };
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'refresh_public_ips') {
    try {
      await fetch(`${getControlBase()}/wan-public-ip/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Best-effort refresh; return current SQLite state if poller is busy
    }
    const summary = getNetworkControlSummary();
    return NextResponse.json({ ok: true, ...summary });
  }

  if (body.ssh_access && typeof body.ssh_access === 'object') {
    const curSsh = getNetworkControlSummary().ssh_access;
    const enabled = body.ssh_access.enabled !== undefined ? Boolean(body.ssh_access.enabled) : curSsh.enabled;
    const targetIp =
      body.ssh_access.target_ip !== undefined ? String(body.ssh_access.target_ip).trim() : curSsh.target_ip;
    const extPort =
      body.ssh_access.external_port !== undefined ? Number(body.ssh_access.external_port) : curSsh.external_port;
    const sshUser =
      body.ssh_access.ssh_user !== undefined ? String(body.ssh_access.ssh_user).trim() : curSsh.ssh_user;

    if (!isValidLanIp(targetIp)) {
      return NextResponse.json(
        { ok: false, code: 'INVALID_LAN_IP', error: 'A valid private LAN IPv4 address is required.' },
        { status: 400 },
      );
    }
    if (!isValidExternalSshPort(extPort)) {
      return NextResponse.json(
        { ok: false, code: 'INVALID_SSH_PORT', error: 'External SSH port must be 22 or between 1024 and 65535.' },
        { status: 400 },
      );
    }
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(sshUser)) {
      return NextResponse.json(
        { ok: false, code: 'INVALID_SSH_USER', error: 'Invalid SSH username.' },
        { status: 400 },
      );
    }

    try {
      const pollerResp = await fetch(`${getControlBase()}/ssh-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          targetIp,
          externalPort: extPort,
          sshUser,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const pollerJson = (await pollerResp.json().catch(() => null)) as { ok?: boolean; code?: string; error?: string } | null;
      if (!pollerResp.ok || !pollerJson?.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: pollerJson?.code ?? 'ROUTER_SSH_MAP_FAILED',
            error: pollerJson?.error ?? 'Failed to apply SSH port mapping on the router.',
          },
          { status: pollerResp.status >= 400 && pollerResp.status < 500 ? pollerResp.status : 502 },
        );
      }
    } catch {
      return NextResponse.json(
        { ok: false, code: 'POLLER_UNREACHABLE', error: 'Poller control plane is unreachable.' },
        { status: 502 },
      );
    }

    const summary = getNetworkControlSummary();
    return NextResponse.json({ ok: true, ...summary });
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
    await fetch(`${getControlBase()}/auto-qos-policy`, {
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
