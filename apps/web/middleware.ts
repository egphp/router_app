import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|api/|setup|.*\\..*).*)'],
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
  if (isConfigured()) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/setup';
  return NextResponse.redirect(url);
}
