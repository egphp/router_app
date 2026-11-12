import { NextResponse } from 'next/server';
import { getOutages } from '../../../lib/queries';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  return NextResponse.json({ outages: getOutages(200) });
}
