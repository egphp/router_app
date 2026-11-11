import { NextResponse } from 'next/server';
import {
  PANEL_CSRF_COOKIE,
  countActivePasskeys,
  guardApiRequest,
  isAuthenticatedRequest,
  isLocalOrLanRequest,
  makeCsrfToken,
  resolveRelyingParty,
  secureCookieForRequest,
} from '../../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req, { allowUnauthenticated: true });
  if (blocked) return blocked;

  const rp = resolveRelyingParty(req);
  const token = makeCsrfToken();
  // One shared owner passkey: 1 when its file is readable, 0 otherwise. Enrolment is closed.
  const count = countActivePasskeys();
  const res = NextResponse.json({
    ok: true,
    passwordlessOnly: true,
    token,
    rpID: rp.rpID,
    origin: rp.origin,
    isSecureOrigin: rp.isSecureOrigin,
    isWebAuthnDomain: rp.isWebAuthnDomain,
    isLocalOrLan: isLocalOrLanRequest(req),
    authenticated: isAuthenticatedRequest(req),
    domainPasskeyCount: count,
    totalPasskeyCount: count,
    firstTimeSetup: false,
    canRegister: false,
    canLogin: count > 0,
    sharedPasskeyReady: count > 0,
    enrollPreview: null,
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
