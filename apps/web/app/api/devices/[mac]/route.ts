import { NextResponse } from 'next/server';
import { getDevice, getDeviceStats, getDeviceTraffic, updateDevice, getDeviceAttacks, type Bucket } from '../../../../lib/queries';

export const dynamic = 'force-dynamic';

const VALID_RANGES: Bucket[] = ['hour', 'today', 'week', 'month', 'year', 'all'];

export async function GET(req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  const macUp = decodeURIComponent(mac).toUpperCase();
  const url = new URL(req.url);
  const range = (url.searchParams.get('range') ?? 'today') as Bucket;
  if (!VALID_RANGES.includes(range)) return NextResponse.json({ error: 'invalid range' }, { status: 400 });
  const device = getDevice(macUp);
  if (!device) return NextResponse.json({ error: 'device not found' }, { status: 404 });
  const traffic = getDeviceTraffic(macUp, range);
  const stats = getDeviceStats(macUp);
  const attacks = getDeviceAttacks(macUp);
  return NextResponse.json({ device, stats, range, traffic, attacks });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  const body = await req.json();
  updateDevice(decodeURIComponent(mac).toUpperCase(), body);
  return NextResponse.json({ ok: true });
}
