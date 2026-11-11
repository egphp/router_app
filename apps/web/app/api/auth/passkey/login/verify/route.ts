import { NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  PANEL_CSRF_COOKIE,
  clientRateLimitScope,
  createPanelSessionCookie,
  guardApiRequest,
  safeNextPath,
  secureCookieForRequest,
  setPanelSessionCookie,
} from '../../../../../../lib/remote-auth';
import {
  clearAuthFailures,
  clearWebAuthnChallengeCookie,
  finishPasskeyAuthentication,
  isRateLimited,
  recordAuthFailure,
} from '../../../../../../lib/passkey-auth';
import { SharedPasskeyUnavailableError } from '../../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req, { allowUnauthenticated: true });
  if (blocked) return blocked;

  const ipScope = clientRateLimitScope(req);
  if (isRateLimited(ipScope)) {
    return NextResponse.json({ ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' }, { status: 429 });
  }

  const body = await readJson(req);
  const response = body.response as AuthenticationResponseJSON | undefined;
  const next = safeNextPath(body.next);

  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    recordAuthFailure(ipScope);
    return NextResponse.json({ ok: false, error: 'Malformed WebAuthn assertion payload.' }, { status: 400 });
  }

  try {
    const verified = await finishPasskeyAuthentication({ req, response });
    clearAuthFailures(ipScope);

    const sessionCookie = createPanelSessionCookie({
      credentialId: verified.credentialId,
      rpId: verified.rpId,
      req,
    });
    const secure = secureCookieForRequest(req);
    const res = NextResponse.json({ ok: true, next, label: verified.label });
    setPanelSessionCookie(res, sessionCookie, secure);
    clearWebAuthnChallengeCookie(res, req);
    res.cookies.set(PANEL_CSRF_COOKIE, '', {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return res;
  } catch (err) {
    if (err instanceof SharedPasskeyUnavailableError) {
      const res503 = NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: 503 });
      clearWebAuthnChallengeCookie(res503, req);
      return res503;
    }
    recordAuthFailure(ipScope);
    const msg = err instanceof Error ? err.message : 'Biometric authentication failed.';
    const res = NextResponse.json({ ok: false, error: msg }, { status: 401 });
    clearWebAuthnChallengeCookie(res, req);
    return res;
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
