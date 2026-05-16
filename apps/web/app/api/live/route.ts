import { NextResponse } from 'next/server';
import { getRecentSpeedSeries } from '../../../lib/queries';
import { getRouterLiveSnapshot } from '../../../lib/router-live';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minutes = Number(url.searchParams.get('minutes') ?? '60');
  const series = getRecentSpeedSeries(minutes);
  const live = await getRouterLiveSnapshot().catch(() => null);
  if (!live) return NextResponse.json(series);

  const since = Date.now() - minutes * 60_000;
  const speeds = [
    ...series.speeds.filter((point) => point.ts >= since && point.ts < live.ts - 500),
    { ts: live.ts, down_bps: live.best_down_bps, up_bps: live.best_up_bps },
  ];

  return NextResponse.json({
    ...series,
    speeds,
    source: 'router-direct',
    latest_ts: live.ts,
    direct: {
      all_devices_down_bps: live.all_devices_down_bps,
      all_devices_up_bps: live.all_devices_up_bps,
      wan_down_bps: live.wan_down_bps,
      wan_up_bps: live.wan_up_bps,
    },
  });
}
