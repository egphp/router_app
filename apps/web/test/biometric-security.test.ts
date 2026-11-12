import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';

// Isolate SQLite & session secret BEFORE importing web auth modules so production tenda.db is untouched.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-biometric-sec-'));
process.env.DB_PATH = path.join(tmpDir, 'test-biometric.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');

import { closeDb, getDb, runMigrations } from '@tenda/shared';
import {
  PANEL_COOKIE,
  PANEL_WEBAUTHN_CHALLENGE_COOKIE,
  clientRateLimitScope,
  createPanelSessionCookie,
  guardApiRequest,
  isLocalOrLanRequest,
  isStrictPrivateOrLoopbackIp,
  isValidRouterHost,
  verifyAuthenticatedSession,
  verifySameOriginRequest,
} from '../lib/remote-auth';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  createEnrollmentToken,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  listPasskeyCredentials,
  revokePasskeyCredential,
  validateEnrollmentTokenPreview,
} from '../lib/passkey-auth';

runMigrations(getDb());

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeReq(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    const cookieStr = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ');
    headers.set('cookie', cookieStr);
  }
  return new Request(url, {
    method: opts.method ?? 'GET',
    headers,
  });
}

function buildEcP256CosePublicKey(pubKey: crypto.KeyObject): Uint8Array {
  const jwk = pubKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // COSE Key Map: 1=kty(2 EC2), 3=alg(-7 ES256), -1=crv(1 P-256), -2=x, -3=y
  const coseMap = new Map<number, number | Uint8Array>();
  coseMap.set(1, 2);
  coseMap.set(3, -7);
  coseMap.set(-1, 1);
  coseMap.set(-2, new Uint8Array(x));
  coseMap.set(-3, new Uint8Array(y));
  return isoCBOR.encode(coseMap as any);
}

function buildAuthenticatorData(opts: {
  rpId: string;
  flags: number;
  counter: number;
  credentialId?: Uint8Array;
  cosePublicKey?: Uint8Array;
}): Buffer {
  const rpIdHash = crypto.createHash('sha256').update(opts.rpId).digest();
  const flagsBuf = Buffer.from([opts.flags]);
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(opts.counter, 0);

  if (!opts.credentialId || !opts.cosePublicKey) {
    return Buffer.concat([rpIdHash, flagsBuf, counterBuf]);
  }

  const aaguid = Buffer.alloc(16, 0);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(opts.credentialId.byteLength, 0);
  return Buffer.concat([
    rpIdHash,
    flagsBuf,
    counterBuf,
    aaguid,
    credLen,
    Buffer.from(opts.credentialId),
    Buffer.from(opts.cosePublicKey),
  ]);
}

describe('Zero-Bypass Network, Proxy, Smuggling, CSRF & SSRF Defenses', () => {
  it('blocks X-Forwarded-For, X-Real-IP, Cloudflare, and evil-subdomain LAN spoofing', () => {
    // Legitimate direct LAN requests
    assert.equal(
      isLocalOrLanRequest(makeReq('http://192.168.0.7:3030/api/devices', { headers: { host: '192.168.0.7:3030' } })),
      true,
    );
    assert.equal(
      isLocalOrLanRequest(makeReq('http://localhost:3030/api/devices', { headers: { host: 'localhost:3030' } })),
      true,
    );

    // Classic header-spoofing attack against remote domain: MUST be false!
    assert.equal(
      isLocalOrLanRequest(
        makeReq('https://panel.example.com/api/devices', {
          headers: {
            host: 'panel.example.com',
            'x-forwarded-for': '127.0.0.1',
            'x-real-ip': '192.168.0.1',
          },
        }),
      ),
      false,
    );

    // Subdomain prefix regex attack (`10.attacker.com`, `192.168.evil.org`) that fooled old regexes:
    assert.equal(isStrictPrivateOrLoopbackIp('10.attacker.com'), false);
    assert.equal(isStrictPrivateOrLoopbackIp('192.168.evil.org'), false);
    assert.equal(
      isLocalOrLanRequest(makeReq('http://10.attacker.com/api/devices', { headers: { host: '10.attacker.com' } })),
      false,
    );

    // Tunnel / Cloudflare proxy forwarding to localhost backend: presence of CF header forces remote auth
    assert.equal(
      isLocalOrLanRequest(
        makeReq('http://localhost:3030/api/devices', {
          headers: {
            host: 'localhost:3030',
            'cf-connecting-ip': '203.0.113.50',
          },
        }),
      ),
      false,
    );

    // Chained X-Forwarded-For where attacker prepends 127.0.0.1 before real public IP
    assert.equal(
      isLocalOrLanRequest(
        makeReq('http://192.168.0.7:3030/api/devices', {
          headers: {
            host: '192.168.0.7:3030',
            'x-forwarded-for': '127.0.0.1, 198.51.100.42',
          },
        }),
      ),
      false,
    );
  });

  it('blocks unauthenticated requests on ALL origins including localhost and LAN (zero LAN bypass)', () => {
    const localReq = makeReq('http://localhost:3030/api/devices', { headers: { host: 'localhost:3030' } });
    const lanReq = makeReq('http://192.168.0.7:3030/api/devices', { headers: { host: '192.168.0.7:3030' } });
    assert.equal(guardApiRequest(localReq)?.status, 401);
    assert.equal(guardApiRequest(lanReq)?.status, 401);
  });

  it('blocks CVE-2025-29927 x-middleware-subrequest smuggling at API guard level with 403', () => {
    const smuggled = makeReq('http://localhost:3030/api/devices', {
      headers: {
        host: 'localhost:3030',
        'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware',
      },
    });
    const res = guardApiRequest(smuggled);
    assert.ok(res);
    assert.equal(res.status, 403);
  });

  it('blocks Cross-Site Request Forgery (CSRF) and DNS-rebinding on mutating requests', () => {
    const crossSitePost = makeReq('https://panel.example.com/api/settings', {
      method: 'POST',
      headers: {
        host: 'panel.example.com',
        origin: 'https://evil.attacker.org',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(verifySameOriginRequest(crossSitePost), false);
    const guardRes = guardApiRequest(crossSitePost, { allowUnauthenticated: true });
    assert.ok(guardRes);
    assert.equal(guardRes.status, 403);

    const nullOriginPost = makeReq('http://localhost:3030/api/settings', {
      method: 'POST',
      headers: {
        host: 'localhost:3030',
        origin: 'null',
        'user-agent': 'Mozilla/5.0',
      },
    });
    assert.equal(verifySameOriginRequest(nullOriginPost), false);

    const validSameOriginPost = makeReq('https://panel.example.com/api/settings', {
      method: 'POST',
      headers: {
        host: 'panel.example.com',
        'x-forwarded-proto': 'https',
        origin: 'https://panel.example.com',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(verifySameOriginRequest(validSameOriginPost), true);
  });

  it('enforces strict SSRF router host validation', () => {
    assert.equal(isValidRouterHost('192.168.0.1'), true);
    assert.equal(isValidRouterHost('10.0.0.1'), true);
    assert.equal(isValidRouterHost('172.16.5.1'), true);
    assert.equal(isValidRouterHost('127.0.0.1'), false); // loopback SSRF blocked
    assert.equal(isValidRouterHost('169.254.169.254'), false); // cloud metadata SSRF blocked
    assert.equal(isValidRouterHost('8.8.8.8'), false); // public internet exfiltration blocked
    assert.equal(isValidRouterHost('192.168.0.1:3031/evil'), false); // port/path injection blocked
    assert.equal(isValidRouterHost('192.168.0.1@evil.com'), false); // authority confusion blocked
  });

  it('prevents rate-limit evasion via User-Agent rotation, leftmost XFF spoofing, or IPv6 /64 rotation', () => {
    const req1 = makeReq('https://panel.example.com/api/auth/passkey/login/verify', {
      headers: {
        host: 'panel.example.com',
        'x-forwarded-for': '1.2.3.4, 198.51.100.77',
        'user-agent': 'Mozilla/5.0 Safari/1',
      },
    });
    const req2 = makeReq('https://panel.example.com/api/auth/passkey/login/verify', {
      headers: {
        host: 'panel.example.com',
        'x-forwarded-for': '9.9.9.9, 198.51.100.77',
        'user-agent': 'Curl/8.0 CustomBot/99',
      },
    });
    assert.equal(clientRateLimitScope(req1), clientRateLimitScope(req2));

    const v6a = makeReq('https://panel.example.com/', {
      headers: { host: 'panel.example.com', 'cf-connecting-ip': '2001:db8:abcd:0012:1111:2222:3333:4444' },
    });
    const v6b = makeReq('https://panel.example.com/', {
      headers: { host: 'panel.example.com', 'cf-connecting-ip': '2001:db8:abcd:0012:aaaa:bbbb:cccc:dddd' },
    });
    assert.equal(clientRateLimitScope(v6a), clientRateLimitScope(v6b));
  });
});

describe('FIDO2 / WebAuthn Hardware Biometric Passkey Engine & Session Binding', () => {
  const rpHost = 'panel.example.com';
  const rpOrigin = `https://${rpHost}`;
  const macChromeUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rawCredId = crypto.randomBytes(32);
  const credIdBase64Url = rawCredId.toString('base64url');
  const cosePublicKey = buildEcP256CosePublicKey(publicKey);

  it('issues SHA-256 hashed one-time enrollment tokens, verifies UV=1 P-256 Passkey registration, and blocks token/challenge replay', async () => {
    const issued = createEnrollmentToken({ createdBy: 'lan', labelHint: 'Owner iPhone 16 Pro' });
    assert.ok(issued.token.length >= 40);

    // Plaintext token must NEVER exist in SQLite
    const rawDbRow = getDb()
      .prepare(`SELECT token_hash FROM passkey_enrollment_tokens WHERE id = 1`)
      .get() as { token_hash: string };
    assert.notEqual(rawDbRow.token_hash, issued.token);
    assert.equal(rawDbRow.token_hash.length, 64);

    const preview = validateEnrollmentTokenPreview(issued.token);
    assert.equal(preview.valid, true);
    assert.ok(preview.id);

    const remoteHeaders = {
      host: rpHost,
      'x-forwarded-proto': 'https',
      'cf-connecting-ip': '198.51.100.25',
      origin: rpOrigin,
      'sec-fetch-site': 'same-origin',
      'user-agent': macChromeUa,
    };

    // 1. Begin registration with enrollment token
    const regStart = await beginPasskeyRegistration({
      req: makeReq(`${rpOrigin}/api/auth/passkey/register/options`, { method: 'POST', headers: remoteHeaders }),
      enrollmentId: preview.id!,
      label: 'MacBook Pro Touch ID',
    });
    assert.equal(regStart.options.rp.id, rpHost);
    assert.equal(regStart.options.authenticatorSelection?.userVerification, 'required');
    assert.equal(regStart.options.authenticatorSelection?.authenticatorAttachment, 'platform');
    assert.equal(regStart.options.authenticatorSelection?.residentKey, 'required');

    // 2. Attempt registration WITHOUT biometric User Verification (UP=1, UV=0, AT=1 -> 0x41) -> MUST FAIL!
    const clientDataReg = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: regStart.options.challenge,
        origin: rpOrigin,
        crossOrigin: false,
      }),
    );
    const noUvAuthData = buildAuthenticatorData({
      rpId: rpHost,
      flags: 0x41, // UP=1, UV=0, AT=1
      counter: 1,
      credentialId: rawCredId,
      cosePublicKey,
    });
    const noUvAttObj = isoCBOR.encode(
      new Map<string, any>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(noUvAuthData)],
      ]) as any,
    );

    await assert.rejects(
      () =>
        finishPasskeyRegistration({
          req: makeReq(`${rpOrigin}/api/auth/passkey/register/verify`, {
            method: 'POST',
            headers: remoteHeaders,
            cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: regStart.challengeCookieValue },
          }),
          response: {
            id: credIdBase64Url,
            rawId: credIdBase64Url,
            type: 'public-key',
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
            response: {
              clientDataJSON: clientDataReg.toString('base64url'),
              attestationObject: Buffer.from(noUvAttObj).toString('base64url'),
              transports: ['internal'],
            },
          },
        }),
      /User verification|Biometric/i,
    );

    // 3. Replaying the consumed challenge from step 2 MUST immediately fail (atomic single-use challenge!)
    await assert.rejects(
      () =>
        finishPasskeyRegistration({
          req: makeReq(`${rpOrigin}/api/auth/passkey/register/verify`, {
            method: 'POST',
            headers: remoteHeaders,
            cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: regStart.challengeCookieValue },
          }),
          response: {
            id: credIdBase64Url,
            rawId: credIdBase64Url,
            type: 'public-key',
            clientExtensionResults: {},
            response: {
              clientDataJSON: clientDataReg.toString('base64url'),
              attestationObject: Buffer.from(noUvAttObj).toString('base64url'),
            },
          },
        }),
      /expired or already used/i,
    );

    // 4. Enrollment token was NOT burned by the failed UV=0 attempt; start a fresh registration with UV=1 (0x45)
    const regStart2 = await beginPasskeyRegistration({
      req: makeReq(`${rpOrigin}/api/auth/passkey/register/options`, { method: 'POST', headers: remoteHeaders }),
      enrollmentId: preview.id!,
      label: 'MacBook Pro Touch ID',
    });
    const clientDataReg2 = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: regStart2.options.challenge,
        origin: rpOrigin,
        crossOrigin: false,
      }),
    );
    const uvAuthData = buildAuthenticatorData({
      rpId: rpHost,
      flags: 0x45, // UP=1 (0x01) | UV=1 (0x04) | AT=1 (0x40)
      counter: 1,
      credentialId: rawCredId,
      cosePublicKey,
    });
    const uvAttObj = isoCBOR.encode(
      new Map<string, any>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(uvAuthData)],
      ]) as any,
    );

    const registered = await finishPasskeyRegistration({
      req: makeReq(`${rpOrigin}/api/auth/passkey/register/verify`, {
        method: 'POST',
        headers: remoteHeaders,
        cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: regStart2.challengeCookieValue },
      }),
      response: {
        id: credIdBase64Url,
        rawId: credIdBase64Url,
        type: 'public-key',
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: clientDataReg2.toString('base64url'),
          attestationObject: Buffer.from(uvAttObj).toString('base64url'),
          transports: ['internal'],
        },
      },
      label: 'MacBook Pro Touch ID',
    });

    assert.equal(registered.credentialId, credIdBase64Url);
    assert.equal(registered.rpId, rpHost);

    // Enrollment token MUST now be permanently burned!
    assert.equal(validateEnrollmentTokenPreview(issued.token).valid, false);

    // Once >= 1 passkey exists in DB, unauthenticated registration WITHOUT an enrollment token MUST be rejected!
    const rogueRegStart = await beginPasskeyRegistration({
      req: makeReq('http://localhost:3030/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { host: 'localhost:3030', origin: 'http://localhost:3030', 'user-agent': macChromeUa },
      }),
      enrollmentId: null,
    });
    const rogueClientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: rogueRegStart.options.challenge,
        origin: 'http://localhost:3030',
        crossOrigin: false,
      }),
    );
    await assert.rejects(
      () =>
        finishPasskeyRegistration({
          req: makeReq('http://localhost:3030/api/auth/passkey/register/verify', {
            method: 'POST',
            headers: { host: 'localhost:3030', origin: 'http://localhost:3030', 'user-agent': macChromeUa },
            cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: rogueRegStart.challengeCookieValue },
          }),
          isAuthedSession: false,
          response: {
            id: crypto.randomBytes(32).toString('base64url'),
            rawId: crypto.randomBytes(32).toString('base64url'),
            type: 'public-key',
            clientExtensionResults: {},
            response: {
              clientDataJSON: rogueClientData.toString('base64url'),
              attestationObject: Buffer.from(uvAttObj).toString('base64url'),
            },
          },
        }),
      /Initial biometric setup is already completed/i,
    );
  });

  it('verifies ECDSA P-256 hardware login assertion, blocks replay, detects cloned counters, and enforces strict session binding + revocation', async () => {
    const remoteHeaders = {
      host: rpHost,
      'x-forwarded-proto': 'https',
      'cf-connecting-ip': '198.51.100.25',
      origin: rpOrigin,
      'sec-fetch-site': 'same-origin',
      'user-agent': macChromeUa,
    };

    const loginStart = await beginPasskeyAuthentication(
      makeReq(`${rpOrigin}/api/auth/passkey/login/options`, { method: 'POST', headers: remoteHeaders }),
    );
    assert.equal(loginStart.options.userVerification, 'required');

    const clientDataLogin = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: loginStart.options.challenge,
        origin: rpOrigin,
        crossOrigin: false,
      }),
    );
    const clientDataHash = crypto.createHash('sha256').update(clientDataLogin).digest();
    const authData = buildAuthenticatorData({
      rpId: rpHost,
      flags: 0x05, // UP=1 | UV=1
      counter: 2,
    });
    const signedPayload = Buffer.concat([authData, clientDataHash]);
    const derSignature = crypto.sign('sha256', signedPayload, privateKey);

    const authResponsePayload = {
      id: credIdBase64Url,
      rawId: credIdBase64Url,
      type: 'public-key' as const,
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
      response: {
        clientDataJSON: clientDataLogin.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: derSignature.toString('base64url'),
      },
    };

    const verifiedLogin = await finishPasskeyAuthentication({
      req: makeReq(`${rpOrigin}/api/auth/passkey/login/verify`, {
        method: 'POST',
        headers: remoteHeaders,
        cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: loginStart.challengeCookieValue },
      }),
      response: authResponsePayload,
    });
    assert.equal(verifiedLogin.credentialId, credIdBase64Url);

    // Replaying exact same signed assertion MUST fail!
    await assert.rejects(
      () =>
        finishPasskeyAuthentication({
          req: makeReq(`${rpOrigin}/api/auth/passkey/login/verify`, {
            method: 'POST',
            headers: remoteHeaders,
            cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: loginStart.challengeCookieValue },
          }),
          response: authResponsePayload,
        }),
      /expired or already consumed/i,
    );

    // Cloned authenticator test: counter regresses from 2 back to 1 -> MUST detect clone!
    const cloneStart = await beginPasskeyAuthentication(
      makeReq(`${rpOrigin}/api/auth/passkey/login/options`, { method: 'POST', headers: remoteHeaders }),
    );
    const cloneClientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: cloneStart.options.challenge,
        origin: rpOrigin,
        crossOrigin: false,
      }),
    );
    const cloneAuthData = buildAuthenticatorData({
      rpId: rpHost,
      flags: 0x05,
      counter: 1, // regressed counter <= stored counter (2)
    });
    const cloneSig = crypto.sign(
      'sha256',
      Buffer.concat([cloneAuthData, crypto.createHash('sha256').update(cloneClientData).digest()]),
      privateKey,
    );

    await assert.rejects(
      () =>
        finishPasskeyAuthentication({
          req: makeReq(`${rpOrigin}/api/auth/passkey/login/verify`, {
            method: 'POST',
            headers: remoteHeaders,
            cookies: { [PANEL_WEBAUTHN_CHALLENGE_COOKIE]: cloneStart.challengeCookieValue },
          }),
          response: {
            id: credIdBase64Url,
            rawId: credIdBase64Url,
            type: 'public-key',
            clientExtensionResults: {},
            response: {
              clientDataJSON: cloneClientData.toString('base64url'),
              authenticatorData: cloneAuthData.toString('base64url'),
              signature: cloneSig.toString('base64url'),
            },
          },
        }),
      /counter anomaly|cloned/i,
    );

    // Issue dual-layer HMAC + SQLite session cookie
    const sessionCookie = createPanelSessionCookie({
      credentialId: credIdBase64Url,
      rpId: rpHost,
      req: makeReq(`${rpOrigin}/`, { headers: remoteHeaders }),
    });

    // Valid session on matching rpID & UA family succeeds
    const authedReq = makeReq(`${rpOrigin}/api/devices`, {
      headers: remoteHeaders,
      cookies: { [PANEL_COOKIE]: sessionCookie },
    });
    assert.ok(verifyAuthenticatedSession(authedReq));
    assert.equal(guardApiRequest(authedReq), null);

    // Stolen cookie replayed from Windows Edge -> rejected by UA family binding!
    const stolenUaReq = makeReq(`${rpOrigin}/api/devices`, {
      headers: {
        ...remoteHeaders,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131.0.0.0',
      },
      cookies: { [PANEL_COOKIE]: sessionCookie },
    });
    assert.equal(verifyAuthenticatedSession(stolenUaReq), null);
    assert.equal(guardApiRequest(stolenUaReq)?.status, 401);

    // Stolen cookie replayed on a different Host/RP -> rejected by rp_id binding!
    const wrongRpReq = makeReq('https://other.example.com/api/devices', {
      headers: {
        ...remoteHeaders,
        host: 'other.example.com',
      },
      cookies: { [PANEL_COOKIE]: sessionCookie },
    });
    assert.equal(verifyAuthenticatedSession(wrongRpReq), null);

    // Tampered HMAC cookie -> rejected!
    const tamperedCookie = `${sessionCookie.slice(0, -4)}XXXX`;
    const tamperedReq = makeReq(`${rpOrigin}/api/devices`, {
      headers: remoteHeaders,
      cookies: { [PANEL_COOKIE]: tamperedCookie },
    });
    assert.equal(verifyAuthenticatedSession(tamperedReq), null);

    // Revoking the Passkey immediately kills all active sessions bound to it!
    assert.equal(revokePasskeyCredential(credIdBase64Url), true);
    assert.equal(verifyAuthenticatedSession(authedReq), null);
    assert.equal(guardApiRequest(authedReq)?.status, 401);

    // Security audit trail recorded clone detection & revocation
    const summary = listPasskeyCredentials();
    assert.equal(summary.credentials.length, 0);
    assert.equal(summary.activeSessions, 0);
    assert.ok(summary.recentEvents.some((e) => e.eventType === 'passkey_clone_detected'));
    assert.ok(summary.recentEvents.some((e) => e.eventType === 'passkey_revoked'));
  });
});
