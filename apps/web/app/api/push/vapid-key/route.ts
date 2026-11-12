import { NextResponse } from 'next/server';
import { getDb, getVapidPublicKey } from '@tenda/shared';
import { guardApiRequest } from '../../../../lib/remote-auth';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  ensureWebMigrations();
  const publicKey = getVapidPublicKey(getDb());
  return NextResponse.json({ publicKey });
}
