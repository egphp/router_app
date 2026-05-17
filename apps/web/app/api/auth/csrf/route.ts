import { NextResponse } from 'next/server';
import {
  PANEL_CSRF_COOKIE,
  isDefaultPanelPasswordActive,
  isPanelPasswordAvailable,
  makeCsrfToken,
  secureCookieForRequest,
} from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = makeCsrfToken();
  const res = NextResponse.json({
    ok: true,
    token,
    configured: isPanelPasswordAvailable(),
    defaultActive: isDefaultPanelPasswordActive(),
  });
  res.cookies.set(PANEL_CSRF_COOKIE, token, {
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });
  return res;
}
