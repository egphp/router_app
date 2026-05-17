import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  PANEL_PASSWORD_HASH_ENV,
  PANEL_SESSION_SECRET_ENV,
  hashPanelPassword,
  isPanelPasswordConfigured,
  makePanelSessionCookie,
  secureCookieForRequest,
  setPanelSessionCookie,
} from '../../../../lib/remote-auth';
import { upsertEnvValues } from '../../../../lib/env-file';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await readJson(req);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 10 || password.length > 256) {
    return NextResponse.json({ ok: false, error: 'password must be 10-256 characters' }, { status: 400 });
  }

  upsertEnvValues({
    [PANEL_PASSWORD_HASH_ENV]: hashPanelPassword(password),
    [PANEL_SESSION_SECRET_ENV]: crypto.randomBytes(32).toString('base64url'),
  });

  const res = NextResponse.json({ ok: true, configured: isPanelPasswordConfigured() });
  setPanelSessionCookie(res, makePanelSessionCookie(), secureCookieForRequest(req));
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
