import { NextResponse } from 'next/server';
import { getDb, sendPushToAll } from '@tenda/shared';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function POST() {
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
