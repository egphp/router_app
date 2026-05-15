import { NextResponse } from 'next/server';
import { getRouterLog } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '500');
  return NextResponse.json({ lines: getRouterLog(limit) });
}
