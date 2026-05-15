import { NextResponse } from 'next/server';
import { getRecentSpeedSeries } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minutes = Number(url.searchParams.get('minutes') ?? '60');
  return NextResponse.json(getRecentSpeedSeries(minutes));
}
