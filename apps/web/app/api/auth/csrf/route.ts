import { NextResponse } from 'next/server';
import {
  hasAnyActivePasskey,
  makeCsrfToken,
  panelCsrfCookieName,
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
    configured: hasAnyActivePasskey(rp.rpID, req),
    defaultActive: false,
  });
  res.cookies.set(panelCsrfCookieName(req), token, {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });
  return res;
}
