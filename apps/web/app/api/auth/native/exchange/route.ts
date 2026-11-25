import { NextResponse } from 'next/server';
import { consumeNativeHandoff } from '../../../../../lib/native-handoff';
import {
  clientRateLimitScope,
  createPanelSessionCookie,
  panelSessionCookieName,
  secureCookieForRequest,
  setPanelSessionCookie,
} from '../../../../../lib/remote-auth';
import { clearAuthFailures, isRateLimited, recordAuthFailure } from '../../../../../lib/passkey-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const scope = `native-exchange:${clientRateLimitScope(req)}`;
  if (isRateLimited(scope)) {
    return NextResponse.json({ ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' }, { status: 429 });
  }

  let code: unknown;
  try {
    const body = await req.json();
    code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  } catch {
    code = undefined;
  }

  const identity = consumeNativeHandoff(code);
  if (!identity) {
    recordAuthFailure(scope);
    return NextResponse.json({ ok: false, error: 'handoff code is invalid or already used' }, { status: 401 });
  }

  clearAuthFailures(scope);
  const sessionCookie = createPanelSessionCookie({
    credentialId: identity.credentialId,
    rpId: identity.rpId,
    req,
  });
  const res = NextResponse.json({
    ok: true,
    cookieName: panelSessionCookieName(req),
    sessionCookie,
  });
  setPanelSessionCookie(res, sessionCookie, secureCookieForRequest(req), req);
  return res;
}
