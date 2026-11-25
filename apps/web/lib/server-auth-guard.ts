import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeNextPath, verifyAuthenticatedSession } from './remote-auth';

/**
 * Serialize Next.js cookie store entries so both `tenda_panel_session` (shared vault)
 * and `tenda_panel_session_<8hex>` (local_vault per-DB isolated cookie) reach
 * `verifyAuthenticatedSession` identically in Server Components.
 */
export function serializeCookieEntries(entries: ReadonlyArray<{ name: string; value: string }>): string {
  return entries
    .filter((c) => Boolean(c.name) && typeof c.value === 'string' && c.value.length > 0)
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join('; ');
}

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
  const serializedCookies = serializeCookieEntries(cookieStore.getAll());
  if (serializedCookies) {
    reqHeaders.set('cookie', serializedCookies);
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
