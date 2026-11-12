import { NextResponse } from 'next/server';
import { getDailyReport } from '../../../lib/queries';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const rawDays = Number(url.searchParams.get('days') ?? '30');
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(365, Math.floor(rawDays))) : 30;
  return NextResponse.json(getDailyReport(days));
}
