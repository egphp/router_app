import crypto from 'node:crypto';
import net from 'node:net';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getDb } from '@tenda/shared';
import { readEnvValue, removeEnvKeys, upsertEnvValues } from './env-file';
import { ensureWebMigrations } from './web-migrations';
import { SHARED_RP_ID, readSharedPasskey } from './shared-passkey';

export const PANEL_SESSION_SECRET_ENV = 'TENDA_PANEL_SESSION_SECRET';
export const LEGACY_PASSWORD_HASH_ENV = 'TENDA_PANEL_PASSWORD_HASH';
export const REQUIRE_BIOMETRIC_EVERYWHERE_ENV = 'TENDA_REQUIRE_BIOMETRIC_EVERYWHERE';

export const PANEL_COOKIE = 'tenda_panel_session';
export const PANEL_CSRF_COOKIE = 'tenda_panel_csrf';
export const PANEL_WEBAUTHN_CHALLENGE_COOKIE = 'tenda_webauthn_chal';

export const PANEL_SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // 400 days, sliding
// A session (database expiry and the signed cookie) is extended when it was last extended more than this long ago.
export const PANEL_SESSION_SLIDE_AFTER_MS = 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_SECONDS = 120; // 2 minutes strict anti-replay window
export const ENROLLMENT_TTL_MS = 5 * 60 * 1000; // 5 minutes one-time pairing window

const EXTERNAL_PROXY_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'true-client-ip',
  'fly-client-ip',
  'fastly-client-ip',
  'x-vercel-id',
  'x-vercel-forwarded-for',
  'x-ngrok-ip',
  'x-amzn-trace-id',
  'x-azure-clientip',
] as const;

const SMUGGLED_INTERNAL_HEADERS = [
  'x-middleware-subrequest',
  'x-middleware-invoke',
  'x-invoke-path',
  'x-invoke-query',
  'x-invoke-output',
] as const;

let cachedSecret: string | null = null;
let legacyCleaned = false;

export function ensureSessionSecret(): string {
  if (!legacyCleaned) {
    legacyCleaned = true;
    if (readEnvValue(LEGACY_PASSWORD_HASH_ENV)) {
      try {
        removeEnvKeys([LEGACY_PASSWORD_HASH_ENV]);
      } catch {
        // Ignore read-only filesystem edge cases; legacy env is never read for auth.
      }
    }
  }
  if (cachedSecret && cachedSecret.length >= 32) return cachedSecret;
  const existing = readEnvValue(PANEL_SESSION_SECRET_ENV);
  if (existing && existing.length >= 32) {
    cachedSecret = existing;
    return existing;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  cachedSecret = generated;
  try {
    upsertEnvValues({ [PANEL_SESSION_SECRET_ENV]: generated });
  } catch {
    process.env[PANEL_SESSION_SECRET_ENV] = generated;
  }
  return generated;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacSign(value: string): string {
  return crypto.createHmac('sha256', ensureSessionSecret()).update(value).digest('base64url');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Constant-time dummy comparison to avoid leaking length timing side-channels
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function hasSmuggledInternalHeaders(req: Request | NextRequest): boolean {
  for (const header of SMUGGLED_INTERNAL_HEADERS) {
    if (req.headers.has(header)) return true;
  }
  return false;
}

/**
 * Strict RFC1918 + Loopback IP validator using Node's `net.isIP`.
 * Never matches domain names like `10.attacker.com` or `192.168.evil.org`.
 */
export function isStrictPrivateOrLoopbackIp(raw: string): boolean {
  let ip = raw.trim().toLowerCase();
  if (!ip) return false;
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }
  // Strip IPv6 zone index if local link-local (e.g. fe80::1%en0)
  const pct = ip.indexOf('%');
  if (pct > 0) ip = ip.slice(0, pct);

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice('::ffff:'.length);
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 Unique Local
    if (ip.startsWith('fe80:')) return true; // fe80::/10 Link-Local
    return false;
  }

  return false;
}

export function extractHostWithoutPort(rawHost: string | null | undefined): string {
  if (!rawHost) return '';
  const first = rawHost.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!first) return '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end > 0 ? first.slice(1, end) : '';
  }
  const colonIdx = first.indexOf(':');
  return colonIdx >= 0 ? first.slice(0, colonIdx) : first;
}

export function isLoopbackOrPrivateHost(hostWithoutPort: string): boolean {
  if (!hostWithoutPort) return false;
  if (hostWithoutPort === 'localhost') return true;
  return isStrictPrivateOrLoopbackIp(hostWithoutPort);
}

/**
 * Unspoofable AND-polarity Local/LAN detector.
 * Spoofing `X-Forwarded-For: 127.0.0.1` or `X-Real-IP: 192.168.1.1` on a remote domain
 * or through any reverse proxy/tunnel NEVER grants LAN trust.
 */
export function isLocalOrLanRequest(req: Request | NextRequest): boolean {
  if (readEnvValue(REQUIRE_BIOMETRIC_EVERYWHERE_ENV) === '1') {
    return false;
  }

  // 1. Any external reverse-proxy / CDN / tunnel header immediately marks the request as remote.
  for (const h of EXTERNAL_PROXY_HEADERS) {
    const val = req.headers.get(h);
    if (val && val.trim().length > 0) return false;
  }

  // 2. Host header MUST exist and be strictly `localhost` or a valid RFC1918/loopback IP.
  const host = extractHostWithoutPort(req.headers.get('host'));
  if (!isLoopbackOrPrivateHost(host)) return false;

  // 3. If X-Forwarded-Host is present, it MUST also be strictly loopback/private IP.
  const xfh = req.headers.get('x-forwarded-host');
  if (xfh !== null) {
    const xfhHost = extractHostWithoutPort(xfh);
    if (!isLoopbackOrPrivateHost(xfhHost)) return false;
  }

  // 4. If X-Forwarded-Proto is https on a non-localhost IP without local TLS, treat cautiously:
  const xfp = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (xfp && xfp !== 'http' && host !== 'localhost') {
    return false;
  }

  // 5. RFC 7239 `Forwarded` header: if present, every `for=` and `host=` parameter must be private/loopback.
  const forwardedHeader = req.headers.get('forwarded');
  if (forwardedHeader !== null) {
    const tokens = forwardedHeader.split(/[;,]/).map((s) => s.trim());
    for (const token of tokens) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      const k = token.slice(0, eq).trim().toLowerCase();
      const v = token.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (k === 'for') {
        const ipOnly = extractHostWithoutPort(v);
        if (!isStrictPrivateOrLoopbackIp(ipOnly)) return false;
      } else if (k === 'host') {
        if (!isLoopbackOrPrivateHost(extractHostWithoutPort(v))) return false;
      }
    }
  }

  // 6. If `X-Forwarded-For` is present, EVERY hop in the chain must be a valid private/loopback IP.
  const xff = req.headers.get('x-forwarded-for');
  if (xff !== null) {
    const hops = xff.split(',').map((s) => s.trim());
    if (hops.length === 0) return false;
    for (const hop of hops) {
      if (!isStrictPrivateOrLoopbackIp(hop)) return false;
    }
  }

  // 7. If `X-Real-IP` is present, it must also be a valid private/loopback IP.
  const realIp = req.headers.get('x-real-ip');
  if (realIp !== null && !isStrictPrivateOrLoopbackIp(realIp)) {
    return false;
  }

  return true;
}

export interface RelyingPartyContext {
  rpID: string;
  origin: string;
  hostWithPort: string;
  proto: 'http' | 'https';
  isSecureOrigin: boolean;
  isWebAuthnDomain: boolean;
}

const VALID_DNS_NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function resolveRelyingParty(req: Request | NextRequest): RelyingPartyContext {
  const xfh = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase() || '';
  const directHost = req.headers.get('host')?.split(',')[0]?.trim().toLowerCase() || 'localhost:3030';
  const hostWithPort = xfh && !/[\s/?#@\\]/.test(xfh) ? xfh : directHost;
  const hostName = extractHostWithoutPort(hostWithPort);

  let proto: 'http' | 'https' = 'http';
  const xfp = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const cfVisitor = req.headers.get('cf-visitor') ?? '';
  if (xfp === 'https' || cfVisitor.includes('"https"')) {
    proto = 'https';
  } else {
    try {
      const parsed = new URL(req.url);
      if (parsed.protocol === 'https:') proto = 'https';
    } catch {
      // ignore
    }
    if (hostName !== 'localhost' && !net.isIP(hostName)) {
      proto = 'https';
    }
  }

  let normalizedHostWithPort =
    (proto === 'https' && hostWithPort.endsWith(':443'))
      ? hostWithPort.slice(0, -4)
      : (proto === 'http' && hostWithPort.endsWith(':80'))
        ? hostWithPort.slice(0, -3)
        : hostWithPort;

  // When nginx uses `proxy_set_header Host $host;` on a custom TLS port (e.g. :209X),
  // `Host` omits the port while the browser sends `Origin: https://<rpID>:<port>`.
  if (proto === 'https' && normalizedHostWithPort === hostName && hostName !== 'localhost' && !net.isIP(hostName)) {
    const rawOrigin = req.headers.get('origin');
    if (rawOrigin && rawOrigin !== 'null') {
      try {
        const parsedOrigin = new URL(rawOrigin);
        if (parsedOrigin.protocol === 'https:' && parsedOrigin.hostname.toLowerCase() === hostName && parsedOrigin.port) {
          normalizedHostWithPort = parsedOrigin.host.toLowerCase();
        }
      } catch {
        // ignore malformed origin
      }
    }
  }

  const origin = `${proto}://${normalizedHostWithPort}`;
  // The WebAuthn rpId is the constant `tv-eg.com` whatever the Host header says
  // (it ignores the port). Only a page served from that exact host (https, any port)
  // can complete the shared-passkey ceremony.
  const onSharedHost = hostName === SHARED_RP_ID;
  const isWebAuthnDomain = onSharedHost;
  const isSecureOrigin = onSharedHost && proto === 'https';

  return {
    rpID: SHARED_RP_ID,
    origin,
    hostWithPort: normalizedHostWithPort,
    proto,
    isSecureOrigin,
    isWebAuthnDomain,
  };
}

/**
 * Validates that a mutating HTTP request (`POST`, `PATCH`, `PUT`, `DELETE`) originated
 * from the exact same Origin as the panel host, blocking Cross-Site Request Forgery (CSRF)
 * and DNS-rebinding / cross-origin LAN attacks.
 */
export function verifySameOriginRequest(req: Request | NextRequest): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const secFetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false;
  }

  const { hostWithPort } = resolveRelyingParty(req);
  const directHost = (req.headers.get('host') ?? '').split(',')[0]!.trim().toLowerCase();

  const matchesExpectedHost = (candidateUrl: string): boolean => {
    try {
      const parsed = new URL(candidateUrl);
      const candHost = parsed.host.toLowerCase();
      return candHost === hostWithPort || (directHost.length > 0 && candHost === directHost);
    } catch {
      return false;
    }
  };

  const origin = req.headers.get('origin');
  if (origin !== null) {
    if (!origin || origin === 'null') return false;
    return matchesExpectedHost(origin);
  }

  const referer = req.headers.get('referer');
  if (referer !== null) {
    return matchesExpectedHost(referer);
  }

  // Non-browser local CLI tools (e.g. curl on 127.0.0.1 without Origin/Referer/Sec-Fetch-*)
  const ua = (req.headers.get('user-agent') ?? '').toLowerCase();
  const looksLikeBrowser = ua.includes('mozilla/') || req.headers.has('sec-fetch-mode');
  if (!looksLikeBrowser && isLocalOrLanRequest(req)) {
    return true;
  }

  return false;
}

/**
 * Validates router IP/hostname to prevent Server-Side Request Forgery (SSRF)
 * and URL/credential injection when testing or saving router credentials.
 */
export function isValidRouterHost(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (/[\s/:?#@\\]/.test(trimmed)) return false;
  if (net.isIPv4(trimmed)) {
    return isStrictPrivateOrLoopbackIp(trimmed) && !trimmed.startsWith('127.');
  }
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(trimmed);
}

/**
 * Unspoofable rate-limit client scope:
 * - Prefers `cf-connecting-ip` when behind Cloudflare, else the RIGHTMOST non-private hop in `x-forwarded-for`,
 *   else `x-real-ip`.
 * - Normalizes IPv6 to its `/64` prefix so attackers cannot rotate IPv6 interface identifiers.
 * - Never includes `User-Agent` (preventing UA rotation bypass).
 */
export function clientRateLimitScope(req: Request | NextRequest): string {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  let ip = cfIp || '';

  if (!ip) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!isStrictPrivateOrLoopbackIp(hops[i]!)) {
          ip = hops[i]!;
          break;
        }
      }
      if (!ip && hops.length > 0) ip = hops[hops.length - 1]!;
    }
  }

  if (!ip) {
    ip = req.headers.get('x-real-ip')?.trim() || 'direct';
  }

  ip = ip.toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (net.isIPv6(ip)) {
    const groups = ip.split(':');
    ip = `${groups.slice(0, 4).join(':')}::/64`;
  }

  return hmacSign(`rl:${ip}`);
}

export function makeCsrfToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function verifyCsrfToken(cookieValue: string | undefined, submitted: unknown): boolean {
  if (!cookieValue || typeof submitted !== 'string' || cookieValue.length < 16) return false;
  return timingSafeStringEqual(cookieValue, submitted);
}

export function readRequestCookie(req: Request | NextRequest, name: string): string | undefined {
  if ('cookies' in req && typeof req.cookies?.get === 'function') {
    return req.cookies.get(name)?.value;
  }
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Shared owner passkeys: how many keys the file stores (0 when unreadable). The old vault rows are not consulted. */
export function hasAnyActivePasskey(_rpId?: string): boolean {
  return readSharedPasskey() !== null;
}

export function countActivePasskeys(_rpId?: string): number {
  return readSharedPasskey()?.keys.length ?? 0;
}

export function createPanelSessionCookie(opts: {
  credentialId: string;
  rpId: string;
  req: Request | NextRequest;
}): string {
  ensureWebMigrations();
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + PANEL_SESSION_MAX_AGE_SECONDS * 1000;
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = sha256Hex(rawToken);
  const ipHash = clientRateLimitScope(opts.req);

  // The shared owner passkey is not a row of `passkey_credentials` (that vault is no
  // longer consulted), yet `panel_sessions.credential_id` references it. The insert is
  // synchronous and outside any transaction, so foreign_keys can be switched off for
  // exactly this statement and restored at once.
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(
      `INSERT INTO panel_sessions (
        session_id_hash, credential_id, rp_id, ua_hash, ip_hash, created_at, last_seen_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(sessionIdHash, opts.credentialId, opts.rpId, '', ipHash, now, now, expiresAt);
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const body = `v2.${rawToken}.${expiresAt}`;
  return `${body}.${hmacSign(body)}`;
}

export interface VerifiedPanelSession {
  sessionIdHash: string;
  credentialId: string;
  rpId: string;
  expiresAt: number;
  /** Set only when called with `slide`: a freshly signed cookie value the response must carry. */
  refreshedCookie?: string;
}

export function verifyAuthenticatedSession(
  req: Request | NextRequest,
  opts: { slide?: boolean } = {},
): VerifiedPanelSession | null {
  const cookieValue = readRequestCookie(req, PANEL_COOKIE);
  if (!cookieValue) return null;

  const parts = cookieValue.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2') return null;
  const rawToken = parts[1]!;
  const cookieExpiresAt = Number(parts[2]);
  const signature = parts[3]!;
  const now = Date.now();

  if (!rawToken || rawToken.length < 32 || !Number.isFinite(cookieExpiresAt) || cookieExpiresAt <= now) {
    return null;
  }

  const body = `${parts[0]}.${rawToken}.${parts[2]}`;
  if (!timingSafeStringEqual(hmacSign(body), signature)) {
    return null;
  }

  // A session counts only while the shared owner passkey file is readable and the
  // session's credential id is any key in the stored set.
  const shared = readSharedPasskey();
  if (!shared) return null;

  ensureWebMigrations();
  const db = getDb();
  const sessionIdHash = sha256Hex(rawToken);
  const row = db
    .prepare(
      `SELECT s.session_id_hash, s.credential_id, s.rp_id, s.last_seen_at, s.expires_at
       FROM panel_sessions s
       WHERE s.session_id_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND s.credential_id IN (${shared.keys.map(() => '?').join(',')})`,
    )
    .get(sessionIdHash, now, ...shared.keys.map((k) => k.id)) as
    | {
        session_id_hash: string;
        credential_id: string;
        rp_id: string;
        last_seen_at: number;
        expires_at: number;
      }
    | undefined;

  if (!row) return null;

  const { rpID } = resolveRelyingParty(req);
  if (row.rp_id !== rpID) {
    return null;
  }

  if (now - row.last_seen_at > 60_000) {
    try {
      db.prepare(`UPDATE panel_sessions SET last_seen_at = ? WHERE session_id_hash = ?`).run(now, sessionIdHash);
    } catch {
      // Non-fatal telemetry timestamp update
    }
  }

  let expiresAt = row.expires_at;
  let refreshedCookie: string | undefined;
  if (opts.slide) {
    // Slide: the stored expiry and the signed cookie each move forward once their last extension is a day old.
    // The last extension time is the expiry minus the full lifetime, so no extra column is needed, and a
    // session signed with the old 14-day lifetime counts as due and is replaced on its next visit.
    const fullMs = PANEL_SESSION_MAX_AGE_SECONDS * 1000;
    const dueBeforeMs = fullMs - PANEL_SESSION_SLIDE_AFTER_MS;
    const dbDue = row.expires_at - now < dueBeforeMs;
    const cookieDue = cookieExpiresAt - now < dueBeforeMs;
    if (dbDue || cookieDue) {
      if (dbDue) {
        try {
          const upd = db
            .prepare(`UPDATE panel_sessions SET expires_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL`)
            .run(now + fullMs, sessionIdHash);
          if (upd.changes > 0) expiresAt = now + fullMs;
        } catch {
          // Keep the stored expiry; the cookie below never outlives it.
        }
      }
      if (expiresAt > cookieExpiresAt) {
        const body = `v2.${rawToken}.${expiresAt}`;
        refreshedCookie = `${body}.${hmacSign(body)}`;
      }
    }
  }

  return {
    sessionIdHash: row.session_id_hash,
    credentialId: row.credential_id,
    rpId: row.rp_id,
    expiresAt,
    ...(refreshedCookie ? { refreshedCookie } : {}),
  };
}

export function isAuthenticatedRequest(req: Request | NextRequest): boolean {
  return verifyAuthenticatedSession(req) !== null;
}

export function revokePanelSessionByRequest(req: Request | NextRequest): boolean {
  const cookieValue = readRequestCookie(req, PANEL_COOKIE);
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2' || !parts[1]) return false;
  const body = `${parts[0]}.${parts[1]}.${parts[2]}`;
  if (!timingSafeStringEqual(hmacSign(body), parts[3]!)) return false;

  ensureWebMigrations();
  const db = getDb();
  const sessionIdHash = sha256Hex(parts[1]);
  const res = db
    .prepare(`UPDATE panel_sessions SET revoked_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL`)
    .run(Date.now(), sessionIdHash);
  return res.changes > 0;
}

export function logSecurityEvent(opts: {
  eventType: string;
  rpId?: string | null;
  credentialId?: string | null;
  ipHash?: string | null;
  detail?: string | null;
}): void {
  try {
    ensureWebMigrations();
    const db = getDb();
    db.prepare(
      `INSERT INTO auth_security_events (event_type, rp_id, credential_id, ip_hash, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.eventType.slice(0, 64),
      opts.rpId ? opts.rpId.slice(0, 255) : null,
      opts.credentialId ? opts.credentialId.slice(0, 255) : null,
      opts.ipHash ? opts.ipHash.slice(0, 128) : null,
      opts.detail ? opts.detail.slice(0, 500) : null,
      Date.now(),
    );
  } catch {
    // Never fail auth path on audit insert error
  }
}

/**
 * Zero-Trust Defense-in-depth guard for API Route Handlers.
 * Enforces header-smuggling rejection, Same-Origin CSRF protection on mutations,
 * and Biometric Passkey session auth on EVERY browser/client (local, LAN, and remote).
 */
export function guardApiRequest(
  req: Request | NextRequest,
  opts: { allowUnauthenticated?: boolean } = {},
): NextResponse | null {
  if (hasSmuggledInternalHeaders(req)) {
    logSecurityEvent({
      eventType: 'bypass_attempt_blocked',
      ipHash: clientRateLimitScope(req),
      detail: 'Smuggled internal Next.js middleware header rejected',
    });
    return NextResponse.json({ ok: false, error: 'forbidden request header' }, { status: 403 });
  }

  if (!verifySameOriginRequest(req)) {
    logSecurityEvent({
      eventType: 'csrf_blocked',
      rpId: resolveRelyingParty(req).rpID,
      ipHash: clientRateLimitScope(req),
      detail: `Cross-origin ${req.method} blocked on ${safePathForLog(req)}`,
    });
    return NextResponse.json({ ok: false, error: 'cross-origin request blocked' }, { status: 403 });
  }

  if (opts.allowUnauthenticated) {
    return null;
  }

  if (!isAuthenticatedRequest(req)) {
    const res = NextResponse.json({ ok: false, error: 'biometric passkey login required' }, { status: 401 });
    if (readRequestCookie(req, PANEL_COOKIE)) {
      clearPanelSessionCookie(res, secureCookieForRequest(req));
    }
    return res;
  }

  return null;
}

export function safeNextPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return fallback;
  try {
    const parsed = new URL(trimmed, 'https://tenda.local');
    if (parsed.origin !== 'https://tenda.local') return fallback;
    if (parsed.pathname === '/login') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function secureCookieForRequest(req: Request | NextRequest): boolean {
  const { proto } = resolveRelyingParty(req);
  if (proto === 'https') return true;
  return !isLocalOrLanRequest(req);
}

export function setPanelSessionCookie(res: NextResponse, value: string, secure: boolean): void {
  res.cookies.set(PANEL_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: PANEL_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearPanelSessionCookie(res: NextResponse, secure: boolean): void {
  res.cookies.set(PANEL_COOKIE, '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function applySecurityHeaders(res: NextResponse, req?: Request | NextRequest): NextResponse {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  );
  res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (req && secureCookieForRequest(req)) {
    res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  return res;
}

function safePathForLog(req: Request | NextRequest): string {
  try {
    return new URL(req.url).pathname.slice(0, 120);
  } catch {
    return 'unknown';
  }
}
