import { NextResponse } from 'next/server';
import { getAlerts, dismissAlert, dismissAllAlerts, markAllDevicesKnown, dismissAlertsByKind } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ alerts: getAlerts(200) });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  if (typeof body?.id === 'number') {
    dismissAlert(body.id);
    return NextResponse.json({ ok: true });
  }
  if (body?.action === 'dismiss_all') {
    const r = dismissAllAlerts();
    return NextResponse.json({ ok: true, changes: r.changes });
  }
  if (body?.action === 'mark_all_known') {
    const r1 = markAllDevicesKnown();
    const r2 = dismissAlertsByKind('new_device');
    return NextResponse.json({ ok: true, devices: r1.changes, alerts: r2.changes });
  }
  if (body?.action === 'dismiss_by_kind' && typeof body?.kind === 'string') {
    const r = dismissAlertsByKind(body.kind);
    return NextResponse.json({ ok: true, changes: r.changes });
  }
  return NextResponse.json({ error: 'invalid request' }, { status: 400 });
}
