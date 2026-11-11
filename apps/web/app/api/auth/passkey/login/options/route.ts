import { NextResponse } from 'next/server';
import {
  PANEL_CSRF_COOKIE,
  clientRateLimitScope,
  guardApiRequest,
  logSecurityEvent,
  readRequestCookie,
  resolveRelyingParty,
  verifyCsrfToken,
} from '../../../../../../lib/remote-auth';
import {
  beginPasskeyAuthentication,
  isRateLimited,
  setWebAuthnChallengeCookie,
} from '../../../../../../lib/passkey-auth';
import { SharedPasskeyUnavailableError } from '../../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req, { allowUnauthenticated: true });
  if (blocked) return blocked;

  const ipScope = clientRateLimitScope(req);
  if (isRateLimited(ipScope)) {
    logSecurityEvent({
      eventType: 'rate_limited',
      rpId: resolveRelyingParty(req).rpID,
      ipHash: ipScope,
      detail: 'Rate limit active during passkey login options',
    });
    return NextResponse.json({ ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' }, { status: 429 });
  }

  const body = await readJson(req);
  if (!verifyCsrfToken(readRequestCookie(req, PANEL_CSRF_COOKIE), body.csrf)) {
    return NextResponse.json({ ok: false, error: 'Invalid or expired security token. Reload page.' }, { status: 400 });
  }

  try {
    const { options, challengeCookieValue } = await beginPasskeyAuthentication(req);
    const res = NextResponse.json({ ok: true, options });
    setWebAuthnChallengeCookie(res, challengeCookieValue, req);
    return res;
  } catch (err) {
    if (err instanceof SharedPasskeyUnavailableError) {
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: 503 });
    }
    const msg = err instanceof Error ? err.message : 'Unable to start biometric login.';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const val = await req.json();
    return val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
