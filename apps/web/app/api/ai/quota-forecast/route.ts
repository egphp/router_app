import { NextResponse } from 'next/server';
import { computeProactiveQuotaForecast } from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const conn = db();
  const forecast = computeProactiveQuotaForecast(conn);
  return NextResponse.json({ ok: true, forecast });
}
