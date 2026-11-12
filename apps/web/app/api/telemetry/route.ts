import { NextResponse } from 'next/server';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

const CONTROL_BASE = `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;

export async function GET(req: Request) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  try {
    const r = await fetch(`${CONTROL_BASE}/telemetry`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return NextResponse.json({ telemetry: null });
    const j = await r.json();
    return NextResponse.json({ telemetry: j.telemetry ?? null });
  } catch {
    return NextResponse.json({ telemetry: null });
  }
}
