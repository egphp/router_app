import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  getDefaultSupportedAlgorithmIDs,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getDb } from '@tenda/shared';
import {
  CHALLENGE_TTL_SECONDS,
  ENROLLMENT_TTL_MS,
  clientRateLimitScope,
  ensureSessionSecret,
  hmacSign,
  logSecurityEvent,
  panelChallengeCookieName,
  readRequestCookie,
  resolveRelyingParty,
  secureCookieForRequest,
  sha256Hex,
  timingSafeStringEqual,
} from './remote-auth';
import {
  EXPECTED_ORIGIN,
  SHARED_LABEL,
  SHARED_RP_ID,
  SharedPasskeyUnavailableError,
  clientDataOrigin,
  isSharedPasskeyInstance,
  normalizeSignature,
  readSharedPasskey,
  sharedKeyFor,
} from './shared-passkey';
import { ensureWebMigrations } from './web-migrations';

const RP_NAME = 'Tenda Router Monitor';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LOCK_MS = 15 * 60 * 1000;
const MAX_AUTH_FAILURES_PER_IP = 8;
const MAX_ENROLL_FAILURES_GLOBAL = 10;

export type PasskeyInstanceMode = 'shared' | 'local_vault';

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
  db.prepare(`DELETE FROM passkey_enrollment_tokens WHERE expires_at < ? AND used_at IS NULL`).run(oneDayAgo);
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

export function globalEnrollRateLimitScope(): string {
  return 'global:enroll-token';
}

export function maxEnrollFailuresGlobal(): number {
  return MAX_ENROLL_FAILURES_GLOBAL;
}

export function createEnrollmentToken(opts: {
  createdBy: 'lan' | 'passkey_session';
  labelHint?: string | null;
  ipHash?: string | null;
}): { token: string; expiresAt: number } {
  cleanupExpiredAuthArtifacts();
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + ENROLLMENT_TTL_MS;
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const cleanLabel = sanitizeDeviceLabel(opts.labelHint);

  db.prepare(
    `INSERT INTO passkey_enrollment_tokens (token_hash, label_hint, created_by, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(tokenHash, cleanLabel, opts.createdBy, now, expiresAt);

  logSecurityEvent({
    eventType: 'enroll_token_created',
    ipHash: opts.ipHash ?? null,
    detail: `One-time biometric pairing token issued via ${opts.createdBy} (TTL 5m)`,
  });

  return { token, expiresAt };
}

export function validateEnrollmentTokenPreview(rawToken: unknown): {
  valid: boolean;
  id?: number;
  labelHint?: string | null;
  expiresAt?: number;
} {
  if (typeof rawToken !== 'string') return { valid: false };
  const trimmed = rawToken.trim();
  if (trimmed.length < 32 || trimmed.length > 128 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { valid: false };
  }
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const tokenHash = sha256Hex(trimmed);
  const row = db
    .prepare(
      `SELECT id, label_hint, expires_at
       FROM passkey_enrollment_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .get(tokenHash, now) as { id: number; label_hint: string | null; expires_at: number } | undefined;

  if (!row) return { valid: false };
  return { valid: true, id: row.id, labelHint: row.label_hint, expiresAt: row.expires_at };
}

export async function beginPasskeyRegistration(opts: {
  req: Request | NextRequest;
  enrollmentId: number | null;
  label?: string | null;
}): Promise<{
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeCookieValue: string;
}> {
  if (isSharedPasskeyInstance(opts.req)) {
    throw new Error('تسجيل بصمات جديدة مقفول نهائياً على هذه اللوحة.');
  }

  cleanupExpiredAuthArtifacts();
  const rp = resolveRelyingParty(opts.req);
  if (!rp.isSecureOrigin || !rp.isWebAuthnDomain) {
    throw new Error(
      `البصمة المشفّرة تتطلب اتصالاً عبر HTTPS أو http://localhost (النطاق الحالي "${rp.rpID}" غير مدعوم).`,
    );
  }

  const db = getDb();
  const existing = db
    .prepare(`SELECT id, transports FROM passkey_credentials WHERE rp_id = ? AND revoked_at IS NULL`)
    .all(rp.rpID) as Array<{ id: string; transports: string | null }>;

  // Unique per-instance userID derived from this host's session secret + exact origin,
  // guaranteeing that registering on https://tv-eg.com:8446 NEVER collides with or
  // overwrites credentials registered on https://tv-eg.com:2055 even on the same device.
  const instanceUserId = new Uint8Array(
    crypto.createHmac('sha256', ensureSessionSecret()).update(`vault-user:${rp.origin}`).digest(),
  );

  const options = await generateRegistrationOptions({
    rpName: `${RP_NAME} (${rp.hostWithPort})`,
    rpID: rp.rpID,
    userID: instanceUserId,
    userName: `admin@${rp.hostWithPort}`,
    userDisplayName: `Tenda Monitor (${rp.hostWithPort})`,
    timeout: 60_000,
    attestationType: 'none',
    supportedAlgorithmIDs: getDefaultSupportedAlgorithmIDs(),
    excludeCredentials: existing.map((cred) => ({
      id: cred.id,
      transports: parseTransports(cred.transports),
    })),
    // Omit authenticatorAttachment so both built-in sensors (Touch ID / Face ID / Windows Hello / Android)
    // AND cross-device phone QR passkeys (hybrid) work seamlessly.
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  const challengeId = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_SECONDS * 1000;
  const ipHash = clientRateLimitScope(opts.req);
  const labelHint = sanitizeDeviceLabel(opts.label) ?? inferDeviceLabel(opts.req.headers.get('user-agent'));

  db.prepare(
    `INSERT INTO webauthn_challenges (
      challenge_id, challenge, purpose, rp_id, expected_origin, enrollment_id, label_hint, ip_hash, created_at, expires_at, consumed_at
    ) VALUES (?, ?, 'register', ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(challengeId, options.challenge, rp.rpID, rp.origin, opts.enrollmentId, labelHint, ipHash, now, expiresAt);

  return {
    options,
    challengeCookieValue: signChallengeCookie(challengeId),
  };
}

export async function finishPasskeyRegistration(opts: {
  req: Request | NextRequest;
  response: RegistrationResponseJSON;
  label?: string | null;
  isAuthedSession?: boolean;
}): Promise<{ credentialId: string; rpId: string; label: string }> {
  if (isSharedPasskeyInstance(opts.req)) {
    throw new Error('تسجيل بصمات جديدة مقفول نهائياً على هذه اللوحة.');
  }

  ensureWebMigrations();
  const db = getDb();
  const rp = resolveRelyingParty(opts.req);
  const ipHash = clientRateLimitScope(opts.req);

  const challengeId = verifyAndExtractChallengeId(opts.req);
  if (!challengeId) {
    throw new Error('انتهت صلاحية جلسة التسجيل — أعد تحميل الصفحة وحاول مرة أخرى.');
  }

  const now = Date.now();
  const chalRow = consumeChallengeAtomically(db, challengeId, 'register', rp.rpID, now);
  if (!chalRow) {
    logSecurityEvent({
      eventType: 'bypass_attempt_blocked',
      rpId: rp.rpID,
      ipHash,
      detail: 'Expired, mismatched, or replayed WebAuthn registration challenge rejected',
    });
    throw new Error('انتهت صلاحية رمز التحدي أو تم استخدامه مسبقاً.');
  }

  if (chalRow.enrollment_id !== null) {
    const enrollStillValid = db
      .prepare(`SELECT id FROM passkey_enrollment_tokens WHERE id = ? AND used_at IS NULL AND expires_at > ?`)
      .get(chalRow.enrollment_id, now) as { id: number } | undefined;
    if (!enrollStillValid) {
      throw new Error('رابط التفعيل لمرة واحدة منتهي الصلاحية أو تم استخدامه.');
    }
  } else if (!opts.isAuthedSession) {
    const existingCount = db
      .prepare(`SELECT COUNT(*) AS n FROM passkey_credentials WHERE revoked_at IS NULL`)
      .get() as { n: number };
    if ((existingCount?.n ?? 0) > 0) {
      logSecurityEvent({
        eventType: 'bypass_attempt_blocked',
        rpId: rp.rpID,
        ipHash,
        detail: 'Blocked unauthenticated passkey registration after initial setup',
      });
      throw new Error('تم تسجيل البصمة الأولى مسبقاً — إضافة بصمة جديدة تتطلب رابط تفعيل من الإعدادات.');
    }
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: chalRow.challenge,
      expectedOrigin: chalRow.expected_origin,
      expectedRPID: chalRow.rp_id,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: getDefaultSupportedAlgorithmIDs(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSecurityEvent({
      eventType: 'passkey_register_failed',
      rpId: chalRow.rp_id,
      ipHash,
      detail: msg.slice(0, 300),
    });
    throw new Error('فشل التحقق التشفيري من تسجيل البصمة (تأكد من فتح الرابط الصحيح).');
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('فشل التحقق التشفيري من تسجيل البصمة.');
  }

  const { registrationInfo } = verification;
  if (!registrationInfo.userVerified) {
    throw new Error('يلزم التحقق البيومتري الفعلي (Touch ID / Face ID / البصمة).');
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid, origin } = registrationInfo;
  const finalLabel =
    sanitizeDeviceLabel(opts.label) ??
    chalRow.label_hint ??
    inferDeviceLabel(opts.req.headers.get('user-agent'));
  const transportsJson = JSON.stringify(
    credential.transports ?? opts.response.response.transports ?? ['internal', 'hybrid'],
  );
  const ua = (opts.req.headers.get('user-agent') ?? '').slice(0, 300);

  const persistTx = db.transaction(() => {
    if (chalRow.enrollment_id !== null) {
      const burn = db
        .prepare(
          `UPDATE passkey_enrollment_tokens
           SET used_at = ?, used_credential_id = ?
           WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .run(now, credential.id, chalRow.enrollment_id, now);
      if (burn.changes !== 1) {
        throw new Error('تم استخدام رابط التفعيل بالفعل.');
      }
    } else if (!opts.isAuthedSession) {
      const activeNow = db
        .prepare(`SELECT COUNT(*) AS n FROM passkey_credentials WHERE revoked_at IS NULL`)
        .get() as { n: number };
      if ((activeNow?.n ?? 0) > 0) {
        throw new Error('تم إتمام التسجيل الأول للبصمة بالفعل.');
      }
    }

    const exists = db
      .prepare(`SELECT id FROM passkey_credentials WHERE id = ?`)
      .get(credential.id) as { id: string } | undefined;
    if (exists) {
      throw new Error('هذه البصمة مسجّلة بالفعل على هذه اللوحة.');
    }

    db.prepare(
      `INSERT INTO passkey_credentials (
        id, public_key, counter, rp_id, origin, transports, device_type, backed_up, aaguid, label, user_agent, created_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      chalRow.rp_id,
      origin,
      transportsJson,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      aaguid || null,
      finalLabel,
      ua || null,
      now,
      now,
    );
  });

  persistTx();

  logSecurityEvent({
    eventType: 'passkey_registered',
    rpId: chalRow.rp_id,
    credentialId: credential.id,
    ipHash,
    detail: `Biometric Passkey registered (${finalLabel}, ${credentialDeviceType})`,
  });

  return {
    credentialId: credential.id,
    rpId: chalRow.rp_id,
    label: finalLabel,
  };
}

export async function beginPasskeyAuthentication(req: Request | NextRequest): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeCookieValue: string;
}> {
  cleanupExpiredAuthArtifacts();

  if (isSharedPasskeyInstance(req)) {
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

  // Standalone local-vault mode (e.g. PPETO on https://tv-eg.com:8446):
  const rp = resolveRelyingParty(req);
  if (!rp.isSecureOrigin || !rp.isWebAuthnDomain) {
    throw new Error(`الدخول بالبصمة يتطلب اتصال HTTPS أو http://localhost (النطاق الحالي: ${rp.rpID}).`);
  }

  const db = getDb();
  const activeCreds = db
    .prepare(`SELECT id, transports FROM passkey_credentials WHERE rp_id = ? AND revoked_at IS NULL`)
    .all(rp.rpID) as Array<{ id: string; transports: string | null }>;

  const totalActive = db
    .prepare(`SELECT COUNT(*) AS n FROM passkey_credentials WHERE revoked_at IS NULL`)
    .get() as { n: number };

  if ((totalActive?.n ?? 0) === 0) {
    throw new Error('لم يتم تسجيل البصمة الأولى بعد — أعد تحميل الصفحة لتسجيل بصمتك الخاصة الآن.');
  }

  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials:
      activeCreds.length > 0
        ? activeCreds.map((c) => {
            const parsed = parseTransports(c.transports);
            const transports = parsed
              ? Array.from(new Set([...parsed, 'internal', 'hybrid']))
              : ['internal', 'hybrid'];
            return {
              id: c.id,
              transports: transports as AuthenticatorTransport[],
            };
          })
        : undefined,
  });

  const challengeId = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_SECONDS * 1000;
  const ipHash = clientRateLimitScope(req);

  db.prepare(
    `INSERT INTO webauthn_challenges (
      challenge_id, challenge, purpose, rp_id, expected_origin, enrollment_id, label_hint, ip_hash, created_at, expires_at, consumed_at
    ) VALUES (?, ?, 'authenticate', ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(challengeId, options.challenge, rp.rpID, rp.origin, ipHash, now, expiresAt);

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

  if (isSharedPasskeyInstance(opts.req)) {
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

  // Standalone local-vault mode:
  const rp = resolveRelyingParty(opts.req);
  const challengeId = verifyAndExtractChallengeId(opts.req);
  if (!challengeId) {
    throw new Error('Authentication challenge cookie missing or expired.');
  }

  const now = Date.now();
  const chalRow = consumeChallengeAtomically(db, challengeId, 'authenticate', rp.rpID, now);
  if (!chalRow) {
    logSecurityEvent({
      eventType: 'bypass_attempt_blocked',
      rpId: rp.rpID,
      ipHash,
      detail: 'Expired, mismatched, or replayed WebAuthn login challenge rejected',
    });
    throw new Error('Authentication challenge expired or already consumed.');
  }

  const credId = typeof opts.response?.id === 'string' ? opts.response.id.trim() : '';
  if (!credId || credId.length > 512) {
    throw new Error('Invalid passkey credential identifier.');
  }

  const credRow = db
    .prepare(
      `SELECT id, public_key, counter, rp_id, origin, transports, label
       FROM passkey_credentials
       WHERE id = ? AND rp_id = ? AND revoked_at IS NULL`,
    )
    .get(credId, chalRow.rp_id) as
    | {
        id: string;
        public_key: Buffer;
        counter: number;
        rp_id: string;
        origin: string;
        transports: string | null;
        label: string;
      }
    | undefined;

  if (!credRow) {
    logSecurityEvent({
      eventType: 'passkey_login_failed',
      rpId: rp.rpID,
      credentialId: credId.slice(0, 64),
      ipHash,
      detail: 'Unknown or revoked credential ID presented',
    });
    throw new Error('Unrecognized or revoked biometric passkey.');
  }

  const expectedOrigins = Array.from(new Set([chalRow.expected_origin, credRow.origin]));

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
      expectedOrigin: expectedOrigins,
      expectedRPID: credRow.rp_id,
      credential: {
        id: credRow.id,
        publicKey: new Uint8Array(credRow.public_key),
        counter: credRow.counter,
        transports: parseTransports(credRow.transports),
      },
      requireUserVerification: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCloneError = /counter/i.test(msg);
    logSecurityEvent({
      eventType: isCloneError ? 'passkey_clone_detected' : 'passkey_login_failed',
      rpId: credRow.rp_id,
      credentialId: credRow.id,
      ipHash,
      detail: msg.slice(0, 300),
    });
    throw new Error(
      isCloneError
        ? 'Security alert: Authenticator signature counter anomaly detected.'
        : 'Biometric cryptographic signature verification failed.',
    );
  }

  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    logSecurityEvent({
      eventType: 'passkey_login_failed',
      rpId: credRow.rp_id,
      credentialId: credRow.id,
      ipHash,
      detail: 'Assertion failed verified/userVerified check',
    });
    throw new Error('Biometric verification required.');
  }

  const { newCounter, credentialDeviceType, credentialBackedUp } = verification.authenticationInfo;
  db.prepare(
    `UPDATE passkey_credentials
     SET counter = ?, last_used_at = ?, device_type = ?, backed_up = ?
     WHERE id = ?`,
  ).run(newCounter, now, credentialDeviceType, credentialBackedUp ? 1 : 0, credRow.id);

  logSecurityEvent({
    eventType: 'passkey_login_ok',
    rpId: credRow.rp_id,
    credentialId: credRow.id,
    ipHash,
    detail: `Biometric login verified (${credRow.label})`,
  });

  return {
    credentialId: credRow.id,
    rpId: credRow.rp_id,
    label: credRow.label,
  };
}

export function listPasskeyCredentials(req?: Request | NextRequest | null): {
  mode: PasskeyInstanceMode;
  credentials: StoredPasskeySummary[];
  activeSessions: number;
  recentEvents: AuthSecurityEventSummary[];
} {
  cleanupExpiredAuthArtifacts();
  const db = getDb();
  const now = Date.now();

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

  const recentEvents = events.map((e) => ({
    id: e.id,
    eventType: e.event_type,
    rpId: e.rp_id,
    credentialPreview: e.credential_id ? `${e.credential_id.slice(0, 8)}…` : null,
    detail: e.detail,
    createdAt: e.created_at,
  }));

  if (isSharedPasskeyInstance(req)) {
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

    return {
      mode: 'shared',
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
      recentEvents,
    };
  }

  const rows = db
    .prepare(
      `SELECT id, rp_id, origin, label, device_type, backed_up, aaguid, created_at, last_used_at
       FROM passkey_credentials
       WHERE revoked_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    rp_id: string;
    origin: string;
    label: string;
    device_type: string;
    backed_up: number;
    aaguid: string | null;
    created_at: number;
    last_used_at: number | null;
  }>;

  const sessionCountRow = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM panel_sessions s
       JOIN passkey_credentials c ON c.id = s.credential_id
       WHERE s.revoked_at IS NULL AND s.expires_at > ? AND c.revoked_at IS NULL`,
    )
    .get(now) as { n: number };

  return {
    mode: 'local_vault',
    credentials: rows.map((r) => ({
      id: r.id,
      idPreview: `${r.id.slice(0, 8)}…${r.id.slice(-6)}`,
      rpId: r.rp_id,
      origin: r.origin,
      label: r.label,
      deviceType: r.device_type,
      backedUp: Boolean(r.backed_up),
      aaguid: r.aaguid,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
    activeSessions: Number(sessionCountRow?.n ?? 0),
    recentEvents,
  };
}

export function revokePasskeyCredential(credentialId: string, ipHash?: string | null): boolean {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();

  const tx = db.transaction(() => {
    const revCred = db
      .prepare(`UPDATE passkey_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(now, credentialId);
    if (revCred.changes === 0) return false;
    db.prepare(`UPDATE panel_sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL`).run(
      now,
      credentialId,
    );
    return true;
  });

  const ok = tx();
  if (ok) {
    logSecurityEvent({
      eventType: 'passkey_revoked',
      credentialId,
      ipHash: ipHash ?? null,
      detail: 'Biometric Passkey and all linked sessions revoked',
    });
  }
  return ok;
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
  res.cookies.set(panelChallengeCookieName(req), value, {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/api/auth/passkey',
    maxAge: CHALLENGE_TTL_SECONDS,
  });
}

export function clearWebAuthnChallengeCookie(res: NextResponse, req: Request | NextRequest): void {
  res.cookies.set(panelChallengeCookieName(req), '', {
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
  const raw = readRequestCookie(req, panelChallengeCookieName(req));
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

function parseTransports(raw: string | null): AuthenticatorTransport[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string') as AuthenticatorTransport[];
    }
  } catch {
    // ignore malformed
  }
  return undefined;
}

function sanitizeDeviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

function inferDeviceLabel(ua: string | null | undefined): string {
  const s = (ua ?? '').toLowerCase();
  if (s.includes('iphone')) return 'iPhone (Face ID / Touch ID)';
  if (s.includes('ipad')) return 'iPad (Face ID / Touch ID)';
  if (s.includes('macintosh') || s.includes('mac os x')) {
    if (s.includes('chrome/')) return 'Mac · Chrome (Touch ID)';
    if (s.includes('safari/')) return 'Mac · Safari (Touch ID)';
    return 'Mac (Touch ID)';
  }
  if (s.includes('android')) return 'Android (Biometric)';
  if (s.includes('windows')) return 'Windows (Passkey)';
  if (s.includes('linux')) return 'Linux (Passkey)';
  return 'Biometric Passkey';
}
