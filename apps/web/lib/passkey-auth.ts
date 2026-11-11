import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { getDb } from '@tenda/shared';
import {
  CHALLENGE_TTL_SECONDS,
  PANEL_WEBAUTHN_CHALLENGE_COOKIE,
  clientRateLimitScope,
  hmacSign,
  logSecurityEvent,
  readRequestCookie,
  resolveRelyingParty,
  secureCookieForRequest,
  timingSafeStringEqual,
} from './remote-auth';
import {
  EXPECTED_ORIGIN,
  SHARED_LABEL,
  SHARED_RP_ID,
  SharedPasskeyUnavailableError,
  normalizeSignature,
  clientDataOrigin,
  readSharedPasskey,
  sharedKeyFor,
} from './shared-passkey';
import { ensureWebMigrations } from './web-migrations';

// One shared owner passkey (see ./shared-passkey.ts): login only, registration is closed.
// The old `passkey_credentials` / `passkey_enrollment_tokens` rows stay on disk, untouched
// and no longer consulted.

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LOCK_MS = 15 * 60 * 1000;
const MAX_AUTH_FAILURES_PER_IP = 8;

export interface StoredPasskeySummary {
  id: string;
  idPreview: string;
  rpId: string;
  origin: string;
  label: string;
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AuthSecurityEventSummary {
  id: number;
  eventType: string;
  rpId: string | null;
  credentialPreview: string | null;
  detail: string | null;
  createdAt: number;
}

export function cleanupExpiredAuthArtifacts(): void {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)`).run(
    now - 5 * 60 * 1000,
    oneDayAgo,
  );
  db.prepare(`DELETE FROM panel_sessions WHERE expires_at < ?`).run(now);
}

export function isRateLimited(scope: string): boolean {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const row = db
    .prepare(`SELECT locked_until FROM remote_login_attempts WHERE scope = ?`)
    .get(scope) as { locked_until: number | null } | undefined;
  return Boolean(row?.locked_until && row.locked_until > now);
}

export function recordAuthFailure(scope: string, maxFailures = MAX_AUTH_FAILURES_PER_IP): boolean {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare(`SELECT failures, first_failed_at, locked_until FROM remote_login_attempts WHERE scope = ?`)
    .get(scope) as { failures: number; first_failed_at: number; locked_until: number | null } | undefined;

  const inWindow = Boolean(existing && now - existing.first_failed_at <= RATE_WINDOW_MS);
  const failures = inWindow ? existing!.failures + 1 : 1;
  const firstFailedAt = inWindow ? existing!.first_failed_at : now;
  const lockedUntil = failures >= maxFailures ? now + RATE_LOCK_MS : null;

  db.prepare(
    `INSERT INTO remote_login_attempts (scope, failures, first_failed_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       failures = excluded.failures,
       first_failed_at = excluded.first_failed_at,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run(scope, failures, firstFailedAt, lockedUntil, now);

  return lockedUntil !== null;
}

export function clearAuthFailures(scope: string): void {
  ensureWebMigrations();
  const db = getDb();
  db.prepare(`DELETE FROM remote_login_attempts WHERE scope = ?`).run(scope);
}

export async function beginPasskeyAuthentication(req: Request | NextRequest): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeCookieValue: string;
}> {
  cleanupExpiredAuthArtifacts();
  const shared = readSharedPasskey();
  if (!shared) throw new SharedPasskeyUnavailableError();

  const rp = resolveRelyingParty(req);
  if (!rp.isSecureOrigin || !rp.isWebAuthnDomain) {
    throw new Error('الدخول بالبصمة يعمل فقط من الرابط https://tv-eg.com (أي بورت)، افتح اللوحة من هذا الرابط.');
  }

  const db = getDb();
  const options = await generateAuthenticationOptions({
    rpID: SHARED_RP_ID,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: shared.keys.map((k) => ({ id: k.id, transports: k.transports })),
  });

  const challengeId = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_SECONDS * 1000;
  const ipHash = clientRateLimitScope(req);

  db.prepare(
    `INSERT INTO webauthn_challenges (
      challenge_id, challenge, purpose, rp_id, expected_origin, enrollment_id, label_hint, ip_hash, created_at, expires_at, consumed_at
    ) VALUES (?, ?, 'authenticate', ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(challengeId, options.challenge, SHARED_RP_ID, rp.origin, ipHash, now, expiresAt);

  return {
    options,
    challengeCookieValue: signChallengeCookie(challengeId),
  };
}

export async function finishPasskeyAuthentication(opts: {
  req: Request | NextRequest;
  response: AuthenticationResponseJSON;
}): Promise<{ credentialId: string; rpId: string; label: string }> {
  ensureWebMigrations();
  const db = getDb();
  const ipHash = clientRateLimitScope(opts.req);

  const challengeId = verifyAndExtractChallengeId(opts.req);
  if (!challengeId) {
    throw new Error('Authentication challenge cookie missing or expired.');
  }

  const now = Date.now();
  const chalRow = consumeChallengeAtomically(db, challengeId, 'authenticate', SHARED_RP_ID, now);
  if (!chalRow) {
    logSecurityEvent({
      eventType: 'bypass_attempt_blocked',
      rpId: SHARED_RP_ID,
      ipHash,
      detail: 'Expired, mismatched, or replayed WebAuthn login challenge rejected',
    });
    throw new Error('Authentication challenge expired or already consumed.');
  }

  const shared = readSharedPasskey();
  if (!shared) {
    logSecurityEvent({
      eventType: 'passkey_login_failed',
      rpId: SHARED_RP_ID,
      ipHash,
      detail: 'Shared passkey file missing or unreadable',
    });
    throw new SharedPasskeyUnavailableError();
  }

  const credId = typeof opts.response?.id === 'string' ? opts.response.id.trim() : '';
  const key = credId && credId.length <= 512 ? sharedKeyFor(shared, credId) : null;
  if (!key || (opts.response.rawId && opts.response.rawId !== key.id)) {
    logSecurityEvent({
      eventType: 'passkey_login_failed',
      rpId: SHARED_RP_ID,
      credentialId: credId.slice(0, 64) || null,
      ipHash,
      detail: 'Credential ID is not the shared owner passkey',
    });
    throw new Error('Unrecognized biometric passkey.');
  }

  // The expected origin is the constant; a different origin fails inside the library.
  // Log the offending origin (only the origin, max 200 chars) as one line.
  const clientOrigin = clientDataOrigin(opts.response.response?.clientDataJSON);
  if (clientOrigin !== EXPECTED_ORIGIN) {
    console.log(`owner-passkey origin_mismatch ${clientOrigin.slice(0, 200)}`);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: {
        ...opts.response,
        response: {
          ...opts.response.response,
          signature: normalizeSignature(opts.response.response.signature),
        },
      },
      expectedChallenge: chalRow.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: SHARED_RP_ID,
      // iCloud passkeys always report counter 0: pass 0 and never persist a counter.
      credential: {
        id: key.id,
        publicKey: key.cose,
        counter: 0,
        transports: key.transports,
      },
      requireUserVerification: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent({
      eventType: 'passkey_login_failed',
      rpId: SHARED_RP_ID,
      credentialId: key.id,
      ipHash,
      detail: msg.slice(0, 300),
    });
    throw new Error('Biometric cryptographic signature verification failed.');
  }

  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    logSecurityEvent({
      eventType: 'passkey_login_failed',
      rpId: SHARED_RP_ID,
      credentialId: key.id,
      ipHash,
      detail: 'Assertion failed verified/userVerified check',
    });
    throw new Error('Biometric verification required.');
  }

  logSecurityEvent({
    eventType: 'passkey_login_ok',
    rpId: SHARED_RP_ID,
    credentialId: key.id,
    ipHash,
    detail: `Biometric login verified (${SHARED_LABEL})`,
  });

  return {
    credentialId: key.id,
    rpId: SHARED_RP_ID,
    label: SHARED_LABEL,
  };
}

/** Read-only view: the one shared credential (no secrets), live session count and the audit trail. */
export function listPasskeyCredentials(): {
  credentials: StoredPasskeySummary[];
  activeSessions: number;
  recentEvents: AuthSecurityEventSummary[];
} {
  cleanupExpiredAuthArtifacts();
  const db = getDb();
  const now = Date.now();
  const shared = readSharedPasskey();

  const sessionCountRow = shared
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM panel_sessions
           WHERE revoked_at IS NULL AND expires_at > ?
             AND credential_id IN (${shared.keys.map(() => '?').join(',')})`,
        )
        .get(now, ...shared.keys.map((k) => k.id)) as { n: number })
    : { n: 0 };

  const events = db
    .prepare(
      `SELECT id, event_type, rp_id, credential_id, detail, created_at
       FROM auth_security_events
       ORDER BY id DESC
       LIMIT 25`,
    )
    .all() as Array<{
    id: number;
    event_type: string;
    rp_id: string | null;
    credential_id: string | null;
    detail: string | null;
    created_at: number;
  }>;

  return {
    credentials: shared
      ? shared.keys.map((k) => ({
          id: k.id,
          idPreview: `${k.id.slice(0, 8)}…${k.id.slice(-6)}`,
          rpId: SHARED_RP_ID,
          origin: `https://${SHARED_RP_ID}`,
          label: SHARED_LABEL,
          deviceType: 'multiDevice' as const,
          backedUp: true,
          aaguid: null,
          createdAt: 0,
          lastUsedAt: null,
        }))
      : [],
    activeSessions: Number(sessionCountRow?.n ?? 0),
    recentEvents: events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      rpId: e.rp_id,
      credentialPreview: e.credential_id ? `${e.credential_id.slice(0, 8)}…` : null,
      detail: e.detail,
      createdAt: e.created_at,
    })),
  };
}

export function revokeAllActiveSessions(ipHash?: string | null): number {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const res = db.prepare(`UPDATE panel_sessions SET revoked_at = ? WHERE revoked_at IS NULL`).run(now);
  logSecurityEvent({
    eventType: 'session_revoked',
    ipHash: ipHash ?? null,
    detail: `Revoked ${res.changes} active biometric session(s)`,
  });
  return res.changes;
}

export function setWebAuthnChallengeCookie(
  res: NextResponse,
  value: string,
  req: Request | NextRequest,
): void {
  res.cookies.set(PANEL_WEBAUTHN_CHALLENGE_COOKIE, value, {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/api/auth/passkey',
    maxAge: CHALLENGE_TTL_SECONDS,
  });
}

export function clearWebAuthnChallengeCookie(res: NextResponse, req: Request | NextRequest): void {
  res.cookies.set(PANEL_WEBAUTHN_CHALLENGE_COOKIE, '', {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/api/auth/passkey',
    maxAge: 0,
  });
}

function signChallengeCookie(challengeId: string): string {
  return `${challengeId}.${hmacSign(`chal:${challengeId}`)}`;
}

function verifyAndExtractChallengeId(req: Request | NextRequest): string | null {
  const raw = readRequestCookie(req, PANEL_WEBAUTHN_CHALLENGE_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const challengeId = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!challengeId || challengeId.length < 16) return null;
  if (!timingSafeStringEqual(hmacSign(`chal:${challengeId}`), sig)) return null;
  return challengeId;
}

interface ChallengeRow {
  challenge_id: string;
  challenge: string;
  purpose: string;
  rp_id: string;
  expected_origin: string;
  enrollment_id: number | null;
  label_hint: string | null;
}

function consumeChallengeAtomically(
  db: ReturnType<typeof getDb>,
  challengeId: string,
  purpose: 'register' | 'authenticate',
  rpId: string,
  now: number,
): ChallengeRow | null {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT challenge_id, challenge, purpose, rp_id, expected_origin, enrollment_id, label_hint
         FROM webauthn_challenges
         WHERE challenge_id = ?
           AND purpose = ?
           AND rp_id = ?
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .get(challengeId, purpose, rpId, now) as ChallengeRow | undefined;
    if (!row) return null;

    const updated = db
      .prepare(
        `UPDATE webauthn_challenges
         SET consumed_at = ?
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(now, challengeId, now);
    return updated.changes === 1 ? row : null;
  });

  return tx();
}

