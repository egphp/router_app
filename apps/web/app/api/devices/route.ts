import { NextResponse } from 'next/server';
import { getLatestDevices } from '../../../lib/queries';
import { getRouterLiveSnapshot, mergeRouterLiveDevices } from '../../../lib/router-live';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const liveRequested = url.searchParams.get('live') === '1';
  const devices = getLatestDevices();
  if (!liveRequested) return NextResponse.json({ devices });

  const live = await getRouterLiveSnapshot().catch(() => null);
  return NextResponse.json({
    devices: mergeRouterLiveDevices(devices, live),
    live_ts: live?.ts ?? null,
    live_source: live?.source ?? null,
  });
}
