import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { isAuthenticatedRequest, isLocalOrLanRequest, isPanelPasswordAvailable, safeNextPath } from './lib/remote-auth';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webmanifest|css|js|map)$).*)'],
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
  const pathname = req.nextUrl.pathname;
  if (isPublicPath(pathname)) return NextResponse.next();

  const configured = isConfigured();
  const isLocalOrLan = isLocalOrLanRequest(req);

  if (!isLocalOrLan && !isPanelPasswordAvailable()) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: 'panel password must be configured locally' }, { status: 403 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (!isLocalOrLan && !isAuthenticatedRequest(req)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: 'login required' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(safeNextPath(`${pathname}${req.nextUrl.search}`))}`;
    return NextResponse.redirect(url);
  }

  if (configured) return NextResponse.next();
  if (pathname === '/setup' || pathname === '/api/settings' || pathname === '/api/setup-status') {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: 'router setup required' }, { status: 428 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/setup';
  return NextResponse.redirect(url);
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/api/auth/csrf' ||
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/push/vapid-key' ||
    pathname === '/api/push/status' ||
    pathname === '/api/push/subscribe' ||
    pathname === '/api/push/unsubscribe'
  );
}
