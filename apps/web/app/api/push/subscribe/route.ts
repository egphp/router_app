import { NextResponse } from 'next/server';
import { getDb, savePushSubscription } from '@tenda/shared';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  ensureWebMigrations();
  const body = await readJson(req);
  const result = savePushSubscription(getDb(), body, {
    clientPlatform: typeof body.client_platform === 'string' ? body.client_platform : null,
    clientUserAgent: req.headers.get('user-agent'),
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
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
