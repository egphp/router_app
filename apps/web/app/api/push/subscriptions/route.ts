import { NextResponse } from 'next/server';
import { getDb, getPushSubscriptionsOverview } from '@tenda/shared';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureWebMigrations();
  return NextResponse.json({ ok: true, ...getPushSubscriptionsOverview(getDb()) });
}
