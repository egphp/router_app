import { NextResponse } from 'next/server';
import { getDb, sendPushToAll } from '@tenda/shared';
import { guardApiRequest } from '../../../../lib/remote-auth';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  ensureWebMigrations();
  const result = await sendPushToAll(getDb(), {
    title: 'اختبار تنبيهات Tenda',
    body: 'التنبيهات شغالة على لوحة Tenda Monitor.',
    url: '/alerts',
    tag: 'tenda-test',
    icon: '/icon-192.png',
  });
  return NextResponse.json({ ok: true, ...result });
}
