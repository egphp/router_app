import { NextResponse } from 'next/server';
import {
  clientRateLimitScope,
  countActivePasskeys,
  guardApiRequest,
  isAuthenticatedRequest,
  logSecurityEvent,
  panelCsrfCookieName,
  readRequestCookie,
  resolveRelyingParty,
  verifyCsrfToken,
} from '../../../../../../lib/remote-auth';
import {
  beginPasskeyRegistration,
  globalEnrollRateLimitScope,
  isRateLimited,
  maxEnrollFailuresGlobal,
  recordAuthFailure,
  setWebAuthnChallengeCookie,
  validateEnrollmentTokenPreview,
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
  const rp = resolveRelyingParty(req);
  const isAuthed = isAuthenticatedRequest(req);
  const totalPasskeys = countActivePasskeys(undefined, req);

  let enrollmentId: number | null = null;
  let enrollLabelHint: string | null = null;

  if (!isAuthed) {
    if (!verifyCsrfToken(readRequestCookie(req, panelCsrfCookieName(req)), body.csrf)) {
      return NextResponse.json({ ok: false, error: 'Invalid or expired security token. Reload page.' }, { status: 400 });
    }

    if (totalPasskeys > 0) {
      if (!body.enrollToken) {
        logSecurityEvent({
          eventType: 'bypass_attempt_blocked',
          rpId: rp.rpID,
          ipHash: ipScope,
          detail: 'Blocked unauthenticated passkey registration attempt when passkey already exists',
        });
        return NextResponse.json(
          { ok: false, error: 'تسجيل البصمات مغلق من الخارج — الإضافة متاحة من داخل الإعدادات (Settings) فقط بعد الدخول.' },
          { status: 403 },
        );
      }

      const globalScope = globalEnrollRateLimitScope();
      if (isRateLimited(globalScope)) {
        return NextResponse.json({ ok: false, error: 'Enrollment temporarily locked due to repeated invalid codes.' }, { status: 429 });
      }

      const tokenCheck = validateEnrollmentTokenPreview(body.enrollToken);
      if (!tokenCheck.valid || !tokenCheck.id) {
        recordAuthFailure(ipScope);
        recordAuthFailure(globalScope, maxEnrollFailuresGlobal());
        logSecurityEvent({
          eventType: 'enroll_token_failed',
          rpId: rp.rpID,
          ipHash: ipScope,
          detail: 'Rejected invalid/expired one-time biometric enrollment token',
        });
        return NextResponse.json(
          { ok: false, error: 'رابط تفعيل البصمة غير صالح أو منتهي الصلاحية.' },
          { status: 403 },
        );
      }
      enrollmentId = tokenCheck.id;
      enrollLabelHint = tokenCheck.labelHint ?? null;
    }
  }

  try {
    const label =
      typeof body.label === 'string' && body.label.trim().length > 0
        ? body.label
        : enrollLabelHint;
    const { options, challengeCookieValue } = await beginPasskeyRegistration({
      req,
      enrollmentId,
      label,
    });
    const res = NextResponse.json({ ok: true, options });
    setWebAuthnChallengeCookie(res, challengeCookieValue, req);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to start biometric passkey registration.';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
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
