import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { getDb } from '@tenda/shared';
import {
  PANEL_CSRF_COOKIE,
  isPanelPasswordAvailable,
  makePanelSessionCookie,
  safeNextPath,
  secureCookieForRequest,
  setPanelSessionCookie,
  verifyCsrfToken,
  verifyPanelPassword,
} from '../../../../lib/remote-auth';
import { ensureWebMigrations } from '../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export async function POST(req: Request) {
  if (!isPanelPasswordAvailable()) {
    return NextResponse.json({ ok: false, error: 'panel password is not configured' }, { status: 503 });
  }

  const body = await readJson(req);
  const password = typeof body.password === 'string' ? body.password : '';
  const csrf = body.csrf;
  const next = safeNextPath(body.next);

  if (!verifyCsrfToken(readCookie(req, PANEL_CSRF_COOKIE), csrf)) {
    return NextResponse.json({ ok: false, error: 'invalid login token' }, { status: 400 });
  }
  if (!password || password.length > 256) {
    return NextResponse.json({ ok: false, error: 'invalid password' }, { status: 400 });
  }

  ensureWebMigrations();
  const db = getDb();
  const scope = requestScope(req);
  const now = Date.now();
  const attempt = db.prepare(
    `SELECT failures, first_failed_at, locked_until FROM remote_login_attempts WHERE scope = ?`,
  ).get(scope) as { failures: number; first_failed_at: number; locked_until: number | null } | undefined;

  if (attempt?.locked_until && attempt.locked_until > now) {
    return NextResponse.json({ ok: false, error: 'too many attempts' }, { status: 429 });
  }

  if (!verifyPanelPassword(password)) {
    recordFailure(db, scope, attempt, now);
    return NextResponse.json({ ok: false, error: 'wrong password' }, { status: 401 });
  }

  db.prepare(`DELETE FROM remote_login_attempts WHERE scope = ?`).run(scope);
  const res = NextResponse.json({ ok: true, next });
  setPanelSessionCookie(res, makePanelSessionCookie(), secureCookieForRequest(req));
  res.cookies.set(PANEL_CSRF_COOKIE, '', {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function requestScope(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const ip = forwarded || req.headers.get('x-real-ip') || 'unknown';
  const ua = req.headers.get('user-agent') ?? '';
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex');
}

function recordFailure(
  db: ReturnType<typeof getDb>,
  scope: string,
  attempt: { failures: number; first_failed_at: number; locked_until: number | null } | undefined,
  now: number,
): void {
  const stillInWindow = Boolean(attempt && now - attempt.first_failed_at <= WINDOW_MS);
  const failures = stillInWindow ? attempt!.failures + 1 : 1;
  const firstFailedAt = stillInWindow ? attempt!.first_failed_at : now;
  const lockedUntil = failures >= MAX_FAILURES ? now + LOCK_MS : null;
  db.prepare(
    `INSERT INTO remote_login_attempts (scope, failures, first_failed_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       failures = excluded.failures,
       first_failed_at = excluded.first_failed_at,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run(scope, failures, firstFailedAt, lockedUntil, now);
}
