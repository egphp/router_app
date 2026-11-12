import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PANEL_COOKIE, safeNextPath, verifyAuthenticatedSession } from './remote-auth';

/**
 * Server-Component Defense-in-Depth Guard:
 * Ensures no Next.js App Router page can ever render or read SQLite data
 * without an active hardware Biometric Passkey session, even if middleware
 * were ever bypassed.
 */
export async function requireServerBiometricAuth(currentPath = '/'): Promise<void> {
  const hdrs = await headers();
  const cookieStore = await cookies();
  const reqHeaders = new Headers();
  hdrs.forEach((value, key) => {
    reqHeaders.set(key, value);
  });
  const sessionCookie = cookieStore.get(PANEL_COOKIE)?.value;
  if (sessionCookie) {
    reqHeaders.set('cookie', `${PANEL_COOKIE}=${encodeURIComponent(sessionCookie)}`);
  }

  const host = reqHeaders.get('x-forwarded-host') || reqHeaders.get('host') || 'localhost:3030';
  const proto = reqHeaders.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const syntheticReq = new Request(`${proto}://${host}${safeNextPath(currentPath)}`, {
    method: 'GET',
    headers: reqHeaders,
  });

  if (!verifyAuthenticatedSession(syntheticReq)) {
    redirect(`/login?next=${encodeURIComponent(safeNextPath(currentPath))}`);
  }
}
