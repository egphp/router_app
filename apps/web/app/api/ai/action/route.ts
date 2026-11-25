import { NextResponse } from 'next/server';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

function getControlBase(): string {
  return `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;
}

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const kind = String(body.kind ?? '');
  if (!['set_qos', 'move_wan', 'reserve_dhcp', 'dismiss_alert', 'rename_device'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'Unsupported action kind' }, { status: 400 });
  }

  try {
    const resp = await fetch(`${getControlBase()}/ai/apply-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const json = (await resp.json().catch(() => null)) as
      | { ok?: boolean; summaryAr?: string; error?: string }
      | null;
    if (!resp.ok || !json?.ok) {
      return NextResponse.json(
        { ok: false, error: json?.error || 'تعذّر تطبيق الإجراء على الراوتر.' },
        { status: resp.status >= 400 && resp.status < 500 ? resp.status : 502 },
      );
    }
    return NextResponse.json({ ok: true, summaryAr: json.summaryAr || 'تم تنفيذ الإجراء بنجاح.' });
  } catch {
    if (kind === 'dismiss_alert' && typeof body.alertId === 'number') {
      const conn = db();
      conn
        .prepare(`UPDATE alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`)
        .run(Date.now(), body.alertId);
      return NextResponse.json({ ok: true, summaryAr: 'تم إغلاق التنبيه محلياً.' });
    }
    return NextResponse.json(
      { ok: false, error: 'خدمة التحكم المحلية (poller) غير متاحة حالياً.' },
      { status: 502 },
    );
  }
}
