import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const CONTROL_BASE = `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;

export async function GET() {
  try {
    const r = await fetch(`${CONTROL_BASE}/router-log`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return NextResponse.json(j);
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'daemon unreachable: ' + String(e), lines: [] }, { status: 500 });
  }
}
