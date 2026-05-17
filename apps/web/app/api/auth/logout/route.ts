import { NextResponse } from 'next/server';
import { clearPanelSessionCookie, secureCookieForRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const res = NextResponse.json({ ok: true });
  clearPanelSessionCookie(res, secureCookieForRequest(req));
  return res;
}
