import { NextResponse } from 'next/server';
import { extractHostWithoutPort } from '../../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

/**
 * Zero-secret localhost loopback beacon used ONLY so a browser tab opened on
 * `http://192.168.x.x:3030/login` on the host Mac itself can detect that
 * `http://localhost:3030` is the exact same local machine and redirect to
 * `localhost` where W3C WebAuthn Touch ID is supported.
 */
export async function GET(req: Request) {
  const host = extractHostWithoutPort(req.headers.get('host'));
  if (host !== 'localhost' && host !== '127.0.0.1') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const origin = req.headers.get('origin') ?? '';
  const res = NextResponse.json({ ok: true, service: 'tenda-biometric-localhost' });
  if (origin && /^http:\/\/(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?$/.test(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
  }
  return res;
}
