import { NextResponse } from 'next/server';
import { getDb, getVapidPublicKey } from '@tenda/shared';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureWebMigrations();
  const publicKey = getVapidPublicKey(getDb());
  return NextResponse.json({ publicKey });
}
