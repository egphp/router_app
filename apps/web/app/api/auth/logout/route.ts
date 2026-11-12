import { NextResponse } from 'next/server';
import {
  clearPanelSessionCookie,
  guardApiRequest,
  revokePanelSessionByRequest,
  secureCookieForRequest,
} from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req, { allowUnauthenticated: true });
  if (blocked) return blocked;

  revokePanelSessionByRequest(req);
  const res = NextResponse.json({ ok: true });
  clearPanelSessionCookie(res, secureCookieForRequest(req));
  return res;
}
