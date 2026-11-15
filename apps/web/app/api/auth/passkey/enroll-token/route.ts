import { NextResponse } from 'next/server';
import {
  clientRateLimitScope,
  guardApiRequest,
  isLocalOrLanRequest,
} from '../../../../../lib/remote-auth';
import { createEnrollmentToken } from '../../../../../lib/passkey-auth';
import { enrolClosedResponse, isSharedPasskeyInstance } from '../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (isSharedPasskeyInstance(req)) {
    return enrolClosedResponse();
  }

  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const body = await readJson(req);
  const labelHint = typeof body.labelHint === 'string' ? body.labelHint : null;
  const createdBy = isLocalOrLanRequest(req) ? 'lan' : 'passkey_session';

  const { token, expiresAt } = createEnrollmentToken({
    createdBy,
    labelHint,
    ipHash: clientRateLimitScope(req),
  });

  return NextResponse.json({
    ok: true,
    token,
    expiresAt,
    ttlSeconds: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
  });
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
