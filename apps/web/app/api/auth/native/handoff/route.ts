import { NextResponse } from 'next/server';
import { issueNativeHandoff } from '../../../../../lib/native-handoff';
import { verifyAuthenticatedSession } from '../../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

/** Runs only after the browser passkey ceremony has already issued a session cookie. */
export async function GET(req: Request) {
  const session = verifyAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'biometric passkey login required' }, { status: 401 });
  }
  const { code } = issueNativeHandoff({
    credentialId: session.credentialId,
    rpId: session.rpId,
  });
  return NextResponse.redirect(`tendavault://auth?code=${encodeURIComponent(code)}`, 302);
}
