import { NextResponse } from 'next/server';
import { getDb } from '@tenda/shared';
import { guardApiRequest, sha256Hex, verifyAuthenticatedSession } from '../../../../lib/remote-auth';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[0-9a-f]{64,200}$/i;

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  const session = verifyAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'biometric passkey login required' }, { status: 401 });
  }

  let body: { token?: unknown; environment?: unknown; bundleId?: unknown; action?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ ok: false, error: 'invalid device token' }, { status: 400 });
  }
  const environment = body.environment === 'sandbox' ? 'sandbox' : 'production';
  const bundleId = typeof body.bundleId === 'string' && /^[A-Za-z0-9.-]{3,120}$/.test(body.bundleId)
    ? body.bundleId
    : 'com.tveg.tendavault';

  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const tokenHash = sha256Hex(token);

  if (body.action === 'disable') {
    db.prepare(
      `UPDATE apns_devices SET disabled_at = ?, updated_at = ? WHERE token_hash = ? AND credential_id = ?`,
    ).run(now, now, tokenHash, session.credentialId);
    return NextResponse.json({ ok: true, disabled: true });
  }

  db.prepare(
    `INSERT INTO apns_devices (token_hash, token, credential_id, bundle_id, environment, created_at, updated_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(token_hash) DO UPDATE SET
       token = excluded.token,
       credential_id = excluded.credential_id,
       bundle_id = excluded.bundle_id,
       environment = excluded.environment,
       updated_at = excluded.updated_at,
       disabled_at = NULL`,
  ).run(tokenHash, token, session.credentialId, bundleId, environment, now, now);

  return NextResponse.json({ ok: true });
}
