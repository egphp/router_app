import { NextResponse } from 'next/server';
import {
  clientRateLimitScope,
  countActivePasskeys,
  guardApiRequest,
  isAuthenticatedRequest,
  isLocalOrLanRequest,
  resolveRelyingParty,
} from '../../../../../lib/remote-auth';
import {
  listPasskeyCredentials,
  revokeAllActiveSessions,
  revokePasskeyCredential,
} from '../../../../../lib/passkey-auth';
import { enrolClosedResponse, isSharedPasskeyInstance } from '../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const rp = resolveRelyingParty(req);
  const summary = listPasskeyCredentials(req);
  return NextResponse.json({
    ok: true,
    rpID: rp.rpID,
    origin: rp.origin,
    isSecureOrigin: rp.isSecureOrigin,
    isWebAuthnDomain: rp.isWebAuthnDomain,
    isLocalOrLan: isLocalOrLanRequest(req),
    authenticated: isAuthenticatedRequest(req),
    ...summary,
  });
}

export async function DELETE(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const ipScope = clientRateLimitScope(req);
  const body = await readJson(req);

  if (body.action === 'revoke_all_sessions') {
    const revoked = revokeAllActiveSessions(ipScope);
    return NextResponse.json({ ok: true, revoked });
  }

  if (isSharedPasskeyInstance(req)) {
    return enrolClosedResponse();
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id || id.length > 512) {
    return NextResponse.json({ ok: false, error: 'Missing passkey credential ID.' }, { status: 400 });
  }

  if (countActivePasskeys(undefined, req) <= 1 && !body.allowLockoutReset) {
    return NextResponse.json(
      { ok: false, error: 'لا يمكن إلغاء آخر بصمة مسجّلة حتى تضيف بصمة جهاز بديل أولاً.' },
      { status: 400 },
    );
  }

  const ok = revokePasskeyCredential(id, ipScope);
  if (!ok) {
    return NextResponse.json({ ok: false, error: 'Passkey not found or already revoked.' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, revokedId: id });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const val = await req.json();
    return val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
