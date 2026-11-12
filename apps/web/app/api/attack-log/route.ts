import { NextResponse } from 'next/server';
import { getAttackLog, getAttackStats } from '../../../lib/queries';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '500');
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(5000, Math.floor(rawLimit))) : 500;
  const logType = url.searchParams.get('type');
  const mac = url.searchParams.get('mac');
  return NextResponse.json({
    entries: getAttackLog({ limit, logType: logType ? Number(logType) : null, mac }),
    stats: getAttackStats(),
  });
}
