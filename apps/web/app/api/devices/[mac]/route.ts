import { NextResponse } from 'next/server';
import { getDevice, getDeviceStats, getDeviceTraffic, getDeviceTrafficForDay, updateDevice, getDeviceAttacks, getDeviceDailyUsage, type Bucket } from '../../../../lib/queries';
import { getRouterLiveSnapshot, mergeRouterLiveDevice } from '../../../../lib/router-live';

export const dynamic = 'force-dynamic';

const VALID_RANGES: Bucket[] = ['hour', 'today', 'week', 'month', 'year', 'all'];

export async function GET(req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  const macUp = decodeURIComponent(mac).toUpperCase();
  const url = new URL(req.url);
  const range = (url.searchParams.get('range') ?? 'today') as Bucket;
  if (!VALID_RANGES.includes(range)) return NextResponse.json({ error: 'invalid range' }, { status: 400 });
  const dayStart = parseLocalDay(url.searchParams.get('day'));
  if (url.searchParams.has('day') && dayStart === null) return NextResponse.json({ error: 'invalid day' }, { status: 400 });
  const device = getDevice(macUp);
  if (!device) return NextResponse.json({ error: 'device not found' }, { status: 404 });
  const liveRequested = url.searchParams.get('live') === '1';
  const live = liveRequested ? await getRouterLiveSnapshot().catch(() => null) : null;
  const traffic = dayStart === null ? getDeviceTraffic(macUp, range) : getDeviceTrafficForDay(macUp, dayStart);
  const stats = getDeviceStats(macUp);
  const attacks = getDeviceAttacks(macUp);
  const dailyUsage = getDeviceDailyUsage(macUp, 365);
  return NextResponse.json({
    device: live ? mergeRouterLiveDevice(device as any, live) : device,
    stats,
    range,
    traffic,
    attacks,
    dailyUsage,
    live_ts: live?.ts ?? null,
    live_source: live?.source ?? null,
  });
}

function parseLocalDay(day: string | null): number | null {
  if (!day) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const parsed = new Date(year, month - 1, date);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== date
  ) {
    return null;
  }
  return parsed.getTime();
}

export async function PATCH(req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  const body = await req.json();
  updateDevice(decodeURIComponent(mac).toUpperCase(), body);
  return NextResponse.json({ ok: true });
}
