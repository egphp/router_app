import { NextResponse } from 'next/server';
import { getDb, getPushSubscriptionHealth } from '@tenda/shared';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  ensureWebMigrations();
  const body = await readJson(req);
  const result = getPushSubscriptionHealth(getDb(), body.endpoint);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
