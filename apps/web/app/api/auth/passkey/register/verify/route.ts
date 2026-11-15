import { NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  clientRateLimitScope,
  createPanelSessionCookie,
  guardApiRequest,
  isAuthenticatedRequest,
  panelCsrfCookieName,
  safeNextPath,
  secureCookieForRequest,
  setPanelSessionCookie,
} from '../../../../../../lib/remote-auth';
import {
  clearAuthFailures,
  clearWebAuthnChallengeCookie,
  finishPasskeyRegistration,
  isRateLimited,
  recordAuthFailure,
} from '../../../../../../lib/passkey-auth';
import { enrolClosedResponse, isSharedPasskeyInstance } from '../../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (isSharedPasskeyInstance(req)) {
    return enrolClosedResponse();
  }

  const blocked = guardApiRequest(req, { allowUnauthenticated: true });
  if (blocked) return blocked;

  const ipScope = clientRateLimitScope(req);
  if (isRateLimited(ipScope)) {
    return NextResponse.json({ ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' }, { status: 429 });
  }

  const body = await readJson(req);
  const response = body.response as RegistrationResponseJSON | undefined;
  const label = typeof body.label === 'string' ? body.label : null;
  const next = safeNextPath(body.next);

  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    recordAuthFailure(ipScope);
    return NextResponse.json({ ok: false, error: 'Malformed WebAuthn registration payload.' }, { status: 400 });
  }

  try {
    const isAuthedSession = isAuthenticatedRequest(req);
    const registered = await finishPasskeyRegistration({ req, response, label, isAuthedSession });
    clearAuthFailures(ipScope);

    const sessionCookie = createPanelSessionCookie({
      credentialId: registered.credentialId,
      rpId: registered.rpId,
      req,
    });
    const secure = secureCookieForRequest(req);
    const res = NextResponse.json({
      ok: true,
      next,
      credentialId: registered.credentialId,
      label: registered.label,
      rpId: registered.rpId,
    });
    setPanelSessionCookie(res, sessionCookie, secure, req);
    clearWebAuthnChallengeCookie(res, req);
    res.cookies.set(panelCsrfCookieName(req), '', {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return res;
  } catch (err) {
    recordAuthFailure(ipScope);
    const msg = err instanceof Error ? err.message : 'Biometric registration verification failed.';
    const res = NextResponse.json({ ok: false, error: msg }, { status: 400 });
    clearWebAuthnChallengeCookie(res, req);
    return res;
  }
}

export async function GET(req: Request) {
  if (isSharedPasskeyInstance(req)) {
    return enrolClosedResponse();
  }
  return NextResponse.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const val = await req.json();
    return val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
