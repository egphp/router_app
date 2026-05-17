import { NextResponse } from 'next/server';
import { loadConfig } from '@tenda/shared';
import { isLocalOrLanRequest, isPanelPasswordConfigured } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

const CONTROL_BASE = `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;

export async function GET() {
  const cfg = loadConfig();
  // Probe daemon health
  let daemonOk = false;
  let daemonHost = cfg.routerHost;
  try {
    const r = await fetch(`${CONTROL_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const j = await r.json();
      daemonOk = j.ok;
      daemonHost = j.host || cfg.routerHost;
    }
  } catch {}
  return NextResponse.json({
    routerHost: daemonHost,
    pollIntervalMs: cfg.pollIntervalMs,
    webPort: cfg.webPort,
    ipcSocket: cfg.ipcSocket,
    dbPath: cfg.dbPath,
    logLevel: cfg.logLevel,
    daemon: { running: daemonOk },
  });
}

export async function POST(req: Request) {
  if (!isPanelPasswordConfigured() && !isLocalOrLanRequest(req)) {
    return NextResponse.json({ ok: false, error: 'initial setup must be done locally' }, { status: 403 });
  }
  const body = await req.json();
  const { action, host, password } = body as { action?: string; host?: string; password?: string };

  if (action === 'test') {
    if (!host || !password) {
      return NextResponse.json({ ok: false, error: 'host + password required' }, { status: 400 });
    }
    try {
      const r = await fetch(`${CONTROL_BASE}/test-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, password }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      return NextResponse.json(j);
    } catch (e) {
      return NextResponse.json({ ok: false, error: 'daemon unreachable: ' + String(e) }, { status: 500 });
    }
  }

  if (action === 'save') {
    if (!host || !password) {
      return NextResponse.json({ ok: false, error: 'host + password required' }, { status: 400 });
    }
    try {
      const r = await fetch(`${CONTROL_BASE}/update-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, password }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      return NextResponse.json(j);
    } catch (e) {
      return NextResponse.json({ ok: false, error: 'daemon unreachable: ' + String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
