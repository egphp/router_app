import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// Simulate PPETO's Ubuntu host: isolated HOME (no ~/.config/egphp-owner/owner-passkey-tv-eg.json),
// isolated SQLite DB, and NO TENDA_SHARED_PASSKEY_FILE env var.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-standalone-vault-'));
process.env.HOME = tmpDir;
delete process.env.TENDA_SHARED_PASSKEY_FILE;
delete process.env.TENDA_PASSKEY_MODE;
process.env.DB_PATH = path.join(tmpDir, 'ppeto-tenda.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.ROUTER_PASSWORD = 'test-router-password';

const { closeDb, getDb, runMigrations } = await import('@tenda/shared');
const remote = await import('../lib/remote-auth.ts');
const sharedPk = await import('../lib/shared-passkey.ts');
const statusRoute = await import('../app/api/auth/passkey/status/route.ts');
const regOptionsRoute = await import('../app/api/auth/passkey/register/options/route.ts');
const regVerifyRoute = await import('../app/api/auth/passkey/register/verify/route.ts');
const loginOptionsRoute = await import('../app/api/auth/passkey/login/options/route.ts');
const loginVerifyRoute = await import('../app/api/auth/passkey/login/verify/route.ts');
const enrollTokenRoute = await import('../app/api/auth/passkey/enroll-token/route.ts');
const credentialsRoute = await import('../app/api/auth/passkey/credentials/route.ts');
const { NextRequest } = await import('next/server');
const { middleware } = await import('../middleware.ts');

runMigrations(getDb());

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

/**
 * Mirrors egphp nginx proxy for https://tv-eg.com:8446:
 *   proxy_set_header Host $host;               -> "tv-eg.com" (port omitted by nginx $host!)
 *   proxy_set_header X-Forwarded-Proto https;
 *   Browser sends Origin: https://tv-eg.com:8446 on POST requests.
 */
function makePpetoReq(
  pathname: string,
  opts: {
    method?: string;
    port?: string;
    cookies?: Record<string, string>;
    body?: unknown;
    includeOrigin?: boolean;
  } = {},
): Request {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const port = opts.port ?? '8446';
  const headers = new Headers({
    host: 'tv-eg.com', // nginx `proxy_set_header Host $host;` omits port
    'x-forwarded-proto': 'https',
    'x-real-ip': '197.55.10.20',
    'x-forwarded-for': '197.55.10.20',
    'user-agent': UA,
  });
  if (opts.includeOrigin ?? method !== 'GET') {
    headers.set('origin', `https://tv-eg.com:${port}`);
    headers.set('sec-fetch-site', 'same-origin');
  }
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers.set(
      'cookie',
      Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; '),
    );
  }
  if (opts.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`http://127.0.0.1:3030${pathname}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function parseSetCookies(res: Response): Record<string, { value: string; raw: string }> {
  const out: Record<string, { value: string; raw: string }> = {};
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0) {
      out[first.slice(0, eq).trim()] = {
        value: decodeURIComponent(first.slice(eq + 1).trim()),
        raw: line,
      };
    }
  }
  return out;
}

function buildAttestationResponse(opts: {
  challenge: string;
  origin: string;
  rpId?: string;
  credIdBytes?: Buffer;
  keyPair: crypto.KeyPairKeyObjectResult;
}) {
  const credIdBuf = opts.credIdBytes ?? crypto.randomBytes(16);
  const credId = credIdBuf.toString('base64url');
  const jwk = opts.keyPair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const cosePublicKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);

  const rpIdHash = sha256(opts.rpId ?? 'tv-eg.com');
  const flags = Buffer.from([0x45]); // UP (0x01) | UV (0x04) | AT (0x40)
  const signCount = Buffer.alloc(4, 0);
  const aaguid = Buffer.alloc(16, 0);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credIdBuf.length, 0);

  const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, credIdBuf, cosePublicKey]);
  assert.ok(authData.length < 256);

  // CBOR map(3): { "fmt": "none", "attStmt": {}, "authData": h'...' }
  const attestationObject = Buffer.concat([
    Buffer.from([0xa3]),
    Buffer.from([0x63]),
    Buffer.from('fmt'),
    Buffer.from([0x64]),
    Buffer.from('none'),
    Buffer.from([0x67]),
    Buffer.from('attStmt'),
    Buffer.from([0xa0]),
    Buffer.from([0x68]),
    Buffer.from('authData'),
    Buffer.from([0x58, authData.length]),
    authData,
  ]);

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }),
  );

  return {
    id: credId,
    rawId: credId,
    type: 'public-key' as const,
    authenticatorAttachment: 'platform' as const,
    clientExtensionResults: {},
    response: {
      attestationObject: attestationObject.toString('base64url'),
      clientDataJSON: clientDataJSON.toString('base64url'),
      transports: ['internal', 'hybrid'] as const,
    },
  };
}

function buildAssertionResponse(opts: {
  challenge: string;
  origin: string;
  credId: string;
  keyPair: crypto.KeyPairKeyObjectResult;
  rpId?: string;
  rawSig?: boolean;
}) {
  const authData = Buffer.concat([
    sha256(opts.rpId ?? 'tv-eg.com'),
    Buffer.from([0x05]), // UP | UV
    Buffer.alloc(4, 0),
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }),
  );
  const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), {
    key: opts.keyPair.privateKey,
    dsaEncoding: opts.rawSig ? 'ieee-p1363' : 'der',
  });
  return {
    id: opts.credId,
    rawId: opts.credId,
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: {
      authenticatorData: authData.toString('base64url'),
      clientDataJSON: clientDataJSON.toString('base64url'),
      signature: sig.toString('base64url'),
    },
  };
}

describe('PPETO standalone local-vault passkey lifecycle (:8446 vs :2055 isolation)', () => {
  const ppetoKey1 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ppetoKey2 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let registeredCredId1 = '';
  let ppetoSessionCookieName = '';
  let ppetoSessionCookieVal = '';

  it('auto-detects local_vault mode on :8446 when owner-passkey-tv-eg.json is absent, while keeping :2055 locked as shared', () => {
    const req8446 = makePpetoReq('/api/auth/passkey/status', { port: '8446', includeOrigin: true });
    const req2055 = makePpetoReq('/api/auth/passkey/status', { port: '2055', includeOrigin: true });
    assert.equal(sharedPk.isSharedPasskeyInstance(req8446), false, ':8446 without shared file must use local_vault');
    assert.equal(sharedPk.isSharedPasskeyInstance(req2055), true, ':2055 must always enforce shared owner passkey');
  });

  it('never touches or clears Michael :2055 tenda_panel_session cookie when visiting :8446', () => {
    const visit8446 = new NextRequest('https://tv-eg.com:8446/', {
      method: 'GET',
      headers: {
        host: 'tv-eg.com',
        'x-forwarded-proto': 'https',
        cookie: 'tenda_panel_session=v2.michael_2055_token_value_1234567890123456.9999999999999.sig',
      },
    });
    const res = middleware(visit8446);
    assert.equal(res.status, 307, 'unauthenticated :8446 redirects to /login');
    const setCookies = parseSetCookies(res);
    assert.equal(setCookies['tenda_panel_session'], undefined, ':8446 must NEVER clear :2055 tenda_panel_session');
  });

  it('offers first-time passkey setup on :8446 when 0 passkeys exist in DB', async () => {
    const res = await statusRoute.GET(makePpetoReq('/api/auth/passkey/status'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'local_vault');
    assert.equal(body.firstTimeSetup, true);
    assert.equal(body.canRegister, true);
    assert.equal(body.canLogin, false);
    assert.equal(body.totalPasskeyCount, 0);

    const setCookies = parseSetCookies(res);
    assert.equal(setCookies['tenda_panel_csrf'], undefined, 'CSRF cookie must be instance-namespaced');
  });

  it('allows PPETO to enroll his own first passkey on https://tv-eg.com:8446 with isolated userID & hybrid/platform support', async () => {
    const statusRes = await statusRoute.GET(makePpetoReq('/api/auth/passkey/status'));
    const statusBody = await statusRes.json();
    const statusCookies = parseSetCookies(statusRes);
    const csrfCookieEntry = Object.entries(statusCookies).find(([k]) => k.startsWith('tenda_panel_csrf_'));
    assert.ok(csrfCookieEntry, 'instance CSRF cookie set');

    const optRes = await regOptionsRoute.POST(
      makePpetoReq('/api/auth/passkey/register/options', {
        cookies: { [csrfCookieEntry[0]]: csrfCookieEntry[1].value },
        body: { csrf: statusBody.token, label: 'PPETO iPhone' },
      }),
    );
    assert.equal(optRes.status, 200);
    const optJson = await optRes.json();
    assert.equal(optJson.ok, true);
    assert.equal(optJson.options.rp.id, 'tv-eg.com');
    assert.equal(optJson.options.user.name, 'admin@tv-eg.com:8446');
    assert.equal(
      optJson.options.authenticatorSelection?.authenticatorAttachment,
      undefined,
      'must allow both built-in biometric sensor and phone QR (hybrid)',
    );

    const optCookies = parseSetCookies(optRes);
    const chalCookieEntry = Object.entries(optCookies).find(([k]) => k.startsWith('tenda_webauthn_chal_'));
    assert.ok(chalCookieEntry, 'instance WebAuthn challenge cookie set');

    // Wrong origin (:2055) must fail verification on a :8446 registration challenge
    const badAttestation = buildAttestationResponse({
      challenge: optJson.options.challenge,
      origin: 'https://tv-eg.com:2055',
      keyPair: ppetoKey1,
    });
    const badVerRes = await regVerifyRoute.POST(
      makePpetoReq('/api/auth/passkey/register/verify', {
        cookies: { [chalCookieEntry[0]]: chalCookieEntry[1].value },
        body: { response: badAttestation, label: 'PPETO iPhone', next: '/' },
      }),
    );
    assert.equal(badVerRes.status, 400, 'mismatched origin rejected');

    // Re-start options since challenge is single-use
    const optRes2 = await regOptionsRoute.POST(
      makePpetoReq('/api/auth/passkey/register/options', {
        cookies: { [csrfCookieEntry[0]]: csrfCookieEntry[1].value },
        body: { csrf: statusBody.token, label: 'PPETO iPhone' },
      }),
    );
    const optJson2 = await optRes2.json();
    const chalCookieEntry2 = Object.entries(parseSetCookies(optRes2)).find(([k]) => k.startsWith('tenda_webauthn_chal_'))!;

    const validAttestation = buildAttestationResponse({
      challenge: optJson2.options.challenge,
      origin: 'https://tv-eg.com:8446',
      keyPair: ppetoKey1,
    });
    const verRes = await regVerifyRoute.POST(
      makePpetoReq('/api/auth/passkey/register/verify', {
        cookies: { [chalCookieEntry2[0]]: chalCookieEntry2[1].value },
        body: { response: validAttestation, label: 'PPETO iPhone', next: '/' },
      }),
    );
    assert.equal(verRes.status, 200);
    const verJson = await verRes.json();
    assert.equal(verJson.ok, true);
    assert.equal(verJson.label, 'PPETO iPhone');
    registeredCredId1 = verJson.credentialId;

    const verCookies = parseSetCookies(verRes);
    const sessEntry = Object.entries(verCookies).find(([k]) => k.startsWith('tenda_panel_session_'));
    assert.ok(sessEntry, 'instance session cookie minted');
    assert.equal(verCookies['tenda_panel_session'], undefined, 'never overwrites :2055 tenda_panel_session');
    ppetoSessionCookieName = sessEntry[0];
    ppetoSessionCookieVal = sessEntry[1].value;
  });

  it('automatically locks public registration on :8446 immediately after the 1st passkey is enrolled', async () => {
    const statusRes = await statusRoute.GET(makePpetoReq('/api/auth/passkey/status'));
    const statusBody = await statusRes.json();
    assert.equal(statusBody.firstTimeSetup, false);
    assert.equal(statusBody.canRegister, false);
    assert.equal(statusBody.canLogin, true);
    assert.equal(statusBody.totalPasskeyCount, 1);

    const csrfEntry = Object.entries(parseSetCookies(statusRes)).find(([k]) => k.startsWith('tenda_panel_csrf_'))!;
    const blockedReg = await regOptionsRoute.POST(
      makePpetoReq('/api/auth/passkey/register/options', {
        cookies: { [csrfEntry[0]]: csrfEntry[1].value },
        body: { csrf: statusBody.token, label: 'Stranger Phone' },
      }),
    );
    assert.equal(blockedReg.status, 403, 'unauthenticated 2nd registration must be blocked');
  });

  it('logs PPETO in on subsequent visits using his :8446 passkey and rejects :2055 assertions', async () => {
    const statusRes = await statusRoute.GET(makePpetoReq('/api/auth/passkey/status'));
    const statusBody = await statusRes.json();
    const csrfEntry = Object.entries(parseSetCookies(statusRes)).find(([k]) => k.startsWith('tenda_panel_csrf_'))!;

    const optRes = await loginOptionsRoute.POST(
      makePpetoReq('/api/auth/passkey/login/options', {
        cookies: { [csrfEntry[0]]: csrfEntry[1].value },
        body: { csrf: statusBody.token },
      }),
    );
    assert.equal(optRes.status, 200);
    const optJson = await optRes.json();
    assert.equal(optJson.options.allowCredentials.length, 1);
    assert.equal(optJson.options.allowCredentials[0].id, registeredCredId1);

    const chalEntry = Object.entries(parseSetCookies(optRes)).find(([k]) => k.startsWith('tenda_webauthn_chal_'))!;

    const assertion = buildAssertionResponse({
      challenge: optJson.options.challenge,
      origin: 'https://tv-eg.com:8446',
      credId: registeredCredId1,
      keyPair: ppetoKey1,
      rawSig: true, // verify raw 64-byte IEEE-P1363 signature normalization works in local_vault too
    });
    const verRes = await loginVerifyRoute.POST(
      makePpetoReq('/api/auth/passkey/login/verify', {
        cookies: { [chalEntry[0]]: chalEntry[1].value },
        body: { response: assertion, next: '/devices' },
      }),
    );
    assert.equal(verRes.status, 200);
    const verJson = await verRes.json();
    assert.equal(verJson.ok, true);
    assert.equal(verJson.next, '/devices');

    // Verify authenticated session passes guardApiRequest & middleware
    const authedReq = makePpetoReq('/api/auth/passkey/credentials', {
      cookies: { [ppetoSessionCookieName]: ppetoSessionCookieVal },
    });
    assert.equal(remote.isAuthenticatedRequest(authedReq), true);
  });

  it('allows authenticated PPETO session to issue a 5-min one-time enroll token and enroll a 2nd device', async () => {
    const tokRes = await enrollTokenRoute.POST(
      makePpetoReq('/api/auth/passkey/enroll-token', {
        cookies: { [ppetoSessionCookieName]: ppetoSessionCookieVal },
        body: { labelHint: 'PPETO Desktop PC' },
      }),
    );
    assert.equal(tokRes.status, 200);
    const tokJson = await tokRes.json();
    assert.equal(tokJson.ok, true);
    assert.ok(tokJson.token.length >= 32);

    // Unauthenticated new device opens /login?enroll=<token>
    const statusRes = await statusRoute.GET(
      makePpetoReq(`/api/auth/passkey/status?enroll=${encodeURIComponent(tokJson.token)}`),
    );
    const statusBody = await statusRes.json();
    assert.equal(statusBody.canRegister, true);
    assert.equal(statusBody.enrollPreview?.valid, true);
    const csrfEntry = Object.entries(parseSetCookies(statusRes)).find(([k]) => k.startsWith('tenda_panel_csrf_'))!;

    const optRes = await regOptionsRoute.POST(
      makePpetoReq('/api/auth/passkey/register/options', {
        cookies: { [csrfEntry[0]]: csrfEntry[1].value },
        body: { csrf: statusBody.token, enrollToken: tokJson.token },
      }),
    );
    assert.equal(optRes.status, 200);
    const optJson = await optRes.json();
    const chalEntry = Object.entries(parseSetCookies(optRes)).find(([k]) => k.startsWith('tenda_webauthn_chal_'))!;

    const att2 = buildAttestationResponse({
      challenge: optJson.options.challenge,
      origin: 'https://tv-eg.com:8446',
      keyPair: ppetoKey2,
    });
    const verRes = await regVerifyRoute.POST(
      makePpetoReq('/api/auth/passkey/register/verify', {
        cookies: { [chalEntry[0]]: chalEntry[1].value },
        body: { response: att2, next: '/' },
      }),
    );
    assert.equal(verRes.status, 200);
    const verJson = await verRes.json();
    assert.equal(verJson.label, 'PPETO Desktop PC');

    const credsRes = await credentialsRoute.GET(
      makePpetoReq('/api/auth/passkey/credentials', {
        cookies: { [ppetoSessionCookieName]: ppetoSessionCookieVal },
      }),
    );
    const credsBody = await credsRes.json();
    assert.equal(credsBody.mode, 'local_vault');
    assert.equal(credsBody.credentials.length, 2);
  });
});
