import { NextResponse } from 'next/server';
import { getDeviceIpHistory } from '../../../../../lib/queries';

export const dynamic = 'force-dynamic';

const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  const macUp = decodeURIComponent(mac).toUpperCase();
  if (!MAC_RE.test(macUp)) {
    return NextResponse.json({ error: 'invalid mac' }, { status: 400 });
  }
  const history = getDeviceIpHistory(macUp);
  return NextResponse.json({ mac: macUp, history });
}
