import crypto from 'node:crypto';
import { getDb } from '@tenda/shared';
import { sha256Hex } from './remote-auth';
import { ensureWebMigrations } from './web-migrations';

const CODE_TTL_MS = 45_000;
const CODE_RE = /^[A-Za-z0-9_-]{43,128}$/;

export interface NativeHandoffIdentity {
  credentialId: string;
  rpId: string;
}

export function issueNativeHandoff(identity: NativeHandoffIdentity): { code: string; expiresAt: number } {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  db.prepare(`DELETE FROM native_handoff_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)`).run(
    now,
    now - 24 * 60 * 60 * 1000,
  );
  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + CODE_TTL_MS;
  db.prepare(
    `INSERT INTO native_handoff_codes (code_hash, credential_id, rp_id, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(sha256Hex(code), identity.credentialId, identity.rpId, now, expiresAt);
  return { code, expiresAt };
}

/** Single use. A second call, an expired code, or a malformed code returns null. */
export function consumeNativeHandoff(rawCode: unknown): NativeHandoffIdentity | null {
  if (typeof rawCode !== 'string' || !CODE_RE.test(rawCode)) return null;
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const hash = sha256Hex(rawCode);
  const changed = db.prepare(
    `UPDATE native_handoff_codes
     SET used_at = ?
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
  ).run(now, hash, now);
  if (changed.changes !== 1) return null;
  const row = db.prepare(
    `SELECT credential_id, rp_id FROM native_handoff_codes WHERE code_hash = ?`,
  ).get(hash) as { credential_id: string; rp_id: string } | undefined;
  if (!row) return null;
  return { credentialId: row.credential_id, rpId: row.rp_id };
}
