import { NextResponse } from 'next/server';
import {
  clientRateLimitScope,
  countActivePasskeys,
  guardApiRequest,
  isAuthenticatedRequest,
  isLocalOrLanRequest,
  logSecurityEvent,
  makeCsrfToken,
  panelCsrfCookieName,
  resolveRelyingParty,
  secureCookieForRequest,
} from '../../../../../lib/remote-auth';
import {
  globalEnrollRateLimitScope,
  isRateLimited,
  maxEnrollFailuresGlobal,
  recordAuthFailure,
  validateEnrollmentTokenPreview,
} from '../../../../../lib/passkey-auth';
import { isSharedPasskeyInstance } from '../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req, { allowUnauthenticated: true });
  if (blocked) return blocked;

  const rp = resolveRelyingParty(req);
  const token = makeCsrfToken();
  const isShared = isSharedPasskeyInstance(req);

  if (isShared) {
    const count = countActivePasskeys(undefined, req);
    const res = NextResponse.json({
      ok: true,
      mode: 'shared',
      passwordlessOnly: true,
      token,
      rpID: rp.rpID,
      hostWithPort: rp.hostWithPort,
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

    res.cookies.set(panelCsrfCookieName(req), token, {
      httpOnly: true,
      secure: secureCookieForRequest(req),
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60,
    });

    return res;
  }

  // Standalone local-vault mode (e.g. PPETO on https://tv-eg.com:8446):
  const url = new URL(req.url);
  const rawEnroll = url.searchParams.get('enroll');

  let enrollPreview: { valid: boolean; labelHint?: string | null; expiresAt?: number } | null = null;
  if (rawEnroll) {
    const ipScope = clientRateLimitScope(req);
    const globalScope = globalEnrollRateLimitScope();
    if (isRateLimited(ipScope) || isRateLimited(globalScope)) {
      enrollPreview = { valid: false };
    } else {
      const check = validateEnrollmentTokenPreview(rawEnroll);
      if (!check.valid) {
        recordAuthFailure(ipScope);
        recordAuthFailure(globalScope, maxEnrollFailuresGlobal());
        logSecurityEvent({
          eventType: 'enroll_token_failed',
          rpId: rp.rpID,
          ipHash: ipScope,
          detail: 'Invalid or expired one-time enrollment token probed on status',
        });
        enrollPreview = { valid: false };
      } else {
        enrollPreview = {
          valid: true,
          labelHint: check.labelHint ?? null,
          expiresAt: check.expiresAt,
        };
      }
    }
  }

  const domainPasskeyCount = countActivePasskeys(rp.rpID, req);
  const totalPasskeyCount = countActivePasskeys(undefined, req);
  const firstTimeSetup = totalPasskeyCount === 0;
  const canRegister = firstTimeSetup || Boolean(enrollPreview?.valid);

  const res = NextResponse.json({
    ok: true,
    mode: 'local_vault',
    passwordlessOnly: true,
    token,
    rpID: rp.rpID,
    hostWithPort: rp.hostWithPort,
    origin: rp.origin,
    isSecureOrigin: rp.isSecureOrigin,
    isWebAuthnDomain: rp.isWebAuthnDomain,
    isLocalOrLan: isLocalOrLanRequest(req),
    authenticated: isAuthenticatedRequest(req),
    domainPasskeyCount,
    totalPasskeyCount,
    firstTimeSetup,
    canRegister,
    canLogin: totalPasskeyCount > 0,
    enrollPreview,
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
