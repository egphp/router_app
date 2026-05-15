import { NextResponse } from 'next/server';
import { getAttackLog, getAttackStats } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '500');
  const logType = url.searchParams.get('type');
  const mac = url.searchParams.get('mac');
  return NextResponse.json({
    entries: getAttackLog({ limit, logType: logType ? Number(logType) : null, mac }),
    stats: getAttackStats(),
  });
}
