import { NextResponse } from 'next/server';
import { getDailyReport } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? '30')));
  return NextResponse.json(getDailyReport(days));
}
