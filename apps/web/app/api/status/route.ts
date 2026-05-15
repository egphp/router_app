import { NextResponse } from 'next/server';
import { getRouterSnapshot } from '../../../lib/queries';
import { MIN } from '@tenda/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snap = getRouterSnapshot();
  const connected = !!snap.last_sample_ts && Date.now() - snap.last_sample_ts < 2 * MIN;
  return NextResponse.json({
    connected,
    alerts: snap.alerts_undismissed,
    last_sample_ts: snap.last_sample_ts,
    uptime_sec: snap.uptime_sec,
    online_count: snap.online_count,
    total_devices: snap.total_devices,
    bytes_today_down: snap.bytes_today_down,
    bytes_today_up: snap.bytes_today_up,
    wan_today_down: snap.wan_today_down,
    wan_today_up: snap.wan_today_up,
    top_device: snap.top_device,
    top_device_2: snap.top_device_2,
  });
}
