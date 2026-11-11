import { NextResponse } from 'next/server';
import {
  clientRateLimitScope,
  guardApiRequest,
  isAuthenticatedRequest,
  isLocalOrLanRequest,
  resolveRelyingParty,
} from '../../../../../lib/remote-auth';
import {
  listPasskeyCredentials,
  revokeAllActiveSessions,
} from '../../../../../lib/passkey-auth';
import { enrolClosedResponse } from '../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const rp = resolveRelyingParty(req);
  const summary = listPasskeyCredentials();
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

  // Revoking a single passkey is gone with enrolment: the one shared key is not managed here.
  return enrolClosedResponse();
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const val = await req.json();
    return val && typeof val === 'object' ? (val as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
