import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import {
  PANEL_COOKIE,
  applySecurityHeaders,
  clearPanelSessionCookie,
  clientRateLimitScope,
  extractHostWithoutPort,
  hasSmuggledInternalHeaders,
  logSecurityEvent,
  readRequestCookie,
  resolveRelyingParty,
  safeNextPath,
  secureCookieForRequest,
  setPanelSessionCookie,
  verifyAuthenticatedSession,
  verifySameOriginRequest,
} from './lib/remote-auth';

export const config = {
  // Never exclude `/api/*` or dynamic routes based on file extensions (prevents `.js`/`.png` suffix bypass).
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico$|icon\\.png$|apple-icon\\.png$|apple-touch-icon\\.png$|logo-original\\.png$|icon-\\d+\\.png$).*)',
  ],
  runtime: 'nodejs',
};

function resolveEnvPath(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const root = path.join(dir, '.env');
      return fs.existsSync(root) ? root : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cache: { mtime: number; configured: boolean } | null = null;

function isConfigured(): boolean {
  if ((process.env.ROUTER_PASSWORD ?? '').trim().length > 0) return true;
  const envPath = resolveEnvPath();
  if (!envPath) return false;
  try {
    const st = fs.statSync(envPath);
    const mtime = st.mtimeMs;
    if (cache && cache.mtime === mtime) return cache.configured;
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^ROUTER_PASSWORD=(.+)$/m);
    const configured = !!(match && match[1].trim().length > 0);
    cache = { mtime, configured };
    return configured;
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  if (hasSmuggledInternalHeaders(req)) {
    logSecurityEvent({
      eventType: 'bypass_attempt_blocked',
      ipHash: clientRateLimitScope(req),
      detail: 'Blocked smuggled internal middleware header',
    });
    return applySecurityHeaders(
      NextResponse.json({ ok: false, error: 'forbidden header' }, { status: 403 }),
      req,
    );
  }

  const pathname = req.nextUrl.pathname;

  // Canonicalize raw 127.0.0.1 loopback to `localhost` so W3C WebAuthn Touch ID works seamlessly
  const hostOnly = extractHostWithoutPort(req.headers.get('host'));
  if (hostOnly === '127.0.0.1' && (req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
    const portPart = (req.headers.get('host') ?? '').includes(':')
      ? `:${(req.headers.get('host') ?? '').split(':')[1]}`
      : '';
    return applySecurityHeaders(
      NextResponse.redirect(`http://localhost${portPart}${pathname}${req.nextUrl.search}`),
      req,
    );
  }

  // Enforce Same-Origin CSRF protection on all state-mutating API calls globally
  if (pathname.startsWith('/api/') && !verifySameOriginRequest(req)) {
    logSecurityEvent({
      eventType: 'csrf_blocked',
      rpId: resolveRelyingParty(req).rpID,
      ipHash: clientRateLimitScope(req),
      detail: `Middleware blocked cross-origin ${req.method} ${pathname}`,
    });
    return applySecurityHeaders(
      NextResponse.json({ ok: false, error: 'cross-origin request blocked' }, { status: 403 }),
      req,
    );
  }

  if (isPublicPath(pathname)) {
    return applySecurityHeaders(NextResponse.next(), req);
  }

  // Zero-Trust Biometric Gate: EVERY browser & API call (local, LAN, Safari, Chrome, mobile, remote)
  // MUST present an active biometric session backed by a non-revoked Passkey in SQLite.
  const verified = verifyAuthenticatedSession(req, { slide: true });
  if (!verified) {
    const hadStaleCookie = Boolean(readRequestCookie(req, PANEL_COOKIE));
    const secure = secureCookieForRequest(req);
    if (pathname.startsWith('/api/')) {
      const res = NextResponse.json({ ok: false, error: 'biometric passkey login required' }, { status: 401 });
      if (hadStaleCookie) clearPanelSessionCookie(res, secure);
      return applySecurityHeaders(res, req);
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(safeNextPath(`${pathname}${req.nextUrl.search}`))}`;
    const res = NextResponse.redirect(url);
    if (hadStaleCookie) clearPanelSessionCookie(res, secure);
    return applySecurityHeaders(res, req);
  }

  // Every authenticated response carries the re-signed cookie when the session was slid.
  const finish = (res: NextResponse): NextResponse => {
    if (verified.refreshedCookie) {
      setPanelSessionCookie(res, verified.refreshedCookie, secureCookieForRequest(req));
    }
    return applySecurityHeaders(res, req);
  };

  const configured = isConfigured();

  if (configured) {
    return finish(NextResponse.next());
  }
  if (pathname === '/setup' || pathname === '/api/settings' || pathname === '/api/setup-status' || pathname === '/api/detect-router') {
    return finish(NextResponse.next());
  }
  if (pathname.startsWith('/api/')) {
    return finish(
      NextResponse.json({ ok: false, error: 'router setup required' }, { status: 428 }));
  }
  const url = req.nextUrl.clone();
  url.pathname = '/setup';
  return finish(NextResponse.redirect(url));
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/api/auth/csrf' ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/auth/passkey/ping' ||
    pathname === '/api/auth/passkey/status' ||
    pathname === '/api/auth/passkey/login/options' ||
    pathname === '/api/auth/passkey/login/verify' ||
    pathname === '/api/auth/passkey/register/options' ||
    pathname === '/api/auth/passkey/register/verify' ||
    pathname === '/api/auth/passkey/enroll-token'
  );
}
