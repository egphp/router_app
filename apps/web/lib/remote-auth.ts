import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readEnvValue } from './env-file';

export const PANEL_PASSWORD_HASH_ENV = 'TENDA_PANEL_PASSWORD_HASH';
export const PANEL_SESSION_SECRET_ENV = 'TENDA_PANEL_SESSION_SECRET';
export const PANEL_COOKIE = 'tenda_panel_session';
export const PANEL_CSRF_COOKIE = 'tenda_panel_csrf';
export const PANEL_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const HASH_PREFIX = 'scrypt';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function panelPasswordHash(): string {
  return readEnvValue(PANEL_PASSWORD_HASH_ENV);
}

export function isPanelPasswordConfigured(): boolean {
  return panelPasswordHash().startsWith(`${HASH_PREFIX}$`);
}

export function hashPanelPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    HASH_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export function verifyPanelPassword(password: string, storedHash = panelPasswordHash()): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function makePanelSessionCookie(): string {
  const expires = Date.now() + PANEL_SESSION_MAX_AGE_SECONDS * 1000;
  const nonce = crypto.randomBytes(18).toString('base64url');
  const body = `v1.${expires}.${nonce}`;
  return `${body}.${sign(body)}`;
}

export function isValidPanelSessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires <= Date.now()) return false;
  const body = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = sign(body);
  return timingSafeStringEqual(expected, parts[3]);
}

export function makeCsrfToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function verifyCsrfToken(cookieValue: string | undefined, submitted: unknown): boolean {
  if (!cookieValue || typeof submitted !== 'string') return false;
  return timingSafeStringEqual(cookieValue, submitted);
}

export function isAuthenticatedRequest(req: NextRequest): boolean {
  if (!isPanelPasswordConfigured()) return true;
  return isValidPanelSessionCookie(req.cookies.get(PANEL_COOKIE)?.value);
}

export function safeNextPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  try {
    const parsed = new URL(trimmed, 'https://tenda.local');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function secureCookieForRequest(req: Request | NextRequest): boolean {
  const headers = req.headers;
  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https') return true;
  const host = headers.get('host')?.split(':')[0]?.toLowerCase() ?? '';
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  return !isPrivateLanHost(host);
}

export function isLocalOrLanRequest(req: Request | NextRequest): boolean {
  const host = req.headers.get('host')?.split(':')[0]?.toLowerCase() ?? '';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || isPrivateLanHost(host)) return true;
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  if (forwarded === '127.0.0.1' || forwarded === '::1' || isPrivateLanHost(forwarded)) return true;
  const realIp = req.headers.get('x-real-ip')?.trim() ?? '';
  return realIp === '127.0.0.1' || realIp === '::1' || isPrivateLanHost(realIp);
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

function sign(value: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function sessionSecret(): string {
  const configured = readEnvValue(PANEL_SESSION_SECRET_ENV);
  if (configured) return configured;
  const hash = panelPasswordHash();
  return hash || 'tenda-panel-session-unconfigured';
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function isPrivateLanHost(host: string): boolean {
  if (/^192\.168\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,2})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}
