import { NextResponse } from 'next/server';
import {
  PANEL_CSRF_COOKIE,
  hasAnyActivePasskey,
  makeCsrfToken,
  resolveRelyingParty,
  secureCookieForRequest,
} from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const rp = resolveRelyingParty(req);
  const token = makeCsrfToken();
  const res = NextResponse.json({
    ok: true,
    passwordlessOnly: true,
    token,
    configured: hasAnyActivePasskey(rp.rpID),
    defaultActive: false,
  });
  res.cookies.set(PANEL_CSRF_COOKIE, token, {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });
  return res;
}
