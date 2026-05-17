import { NextResponse } from 'next/server';
import { expirePushSubscription, getDb } from '@tenda/shared';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  ensureWebMigrations();
  const body = await readJson(req);
  const ok = expirePushSubscription(getDb(), body.endpoint);
  return NextResponse.json({ ok });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
