import { NextResponse } from 'next/server';
import { getAlerts, dismissAlert } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ alerts: getAlerts(100) });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  if (typeof body?.id !== 'number') return NextResponse.json({ error: 'id required' }, { status: 400 });
  dismissAlert(body.id);
  return NextResponse.json({ ok: true });
}
