/**
 * Shared owner passkey (2026-11-11): one Apple passkey opens the Tenda panel.
 *   node --import ../../packages/poller/node_modules/tsx/dist/loader.mjs --test test/shared-passkey.test.ts
 * TENDA_TEST_SRC_DIR points the same test at another copy of lib/ + app/api/auth/passkey
 * (used once to prove it fails against the pre-change code).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-shared-passkey-'));
process.env.DB_PATH = path.join(tmpDir, 'test-shared.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
const SHARED_FILE = path.join(tmpDir, 'owner-passkey-tv-eg.json');
process.env.TENDA_SHARED_PASSKEY_FILE = SHARED_FILE;

const SRC = process.env.TENDA_TEST_SRC_DIR || path.resolve(import.meta.dirname, '..');
const { closeDb, getDb, runMigrations } = await import('@tenda/shared');
const remote = await import(path.join(SRC, 'lib/remote-auth.ts'));
const pk = await import(path.join(SRC, 'lib/passkey-auth.ts'));
const sharedPk = await import(path.join(SRC, 'lib/shared-passkey.ts'));
const routeOf = async (p: string) => import(path.join(SRC, 'app/api/auth/passkey', p, 'route.ts'));

runMigrations(getDb());
after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();
const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const otherPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credId = crypto.randomBytes(16).toString('base64url');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

function writeShared(id = credId, pair = keyPair) {
  fs.writeFileSync(
    SHARED_FILE,
    JSON.stringify({
      credentialId: id,
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      rpId: 'tv-eg.com',
    }),
    { mode: 0o600 },
  );
}

function makeReq(opts: { port?: string; cookie?: string; method?: string; ua?: string } = {}): Request {
  const host = `tv-eg.com${opts.port ? ':' + opts.port : ''}`;
  const headers = new Headers({
    host,
    'x-forwarded-proto': 'https',
    'user-agent': opts.ua ?? UA,
    origin: `https://${host}`,
  });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new Request(`https://${host}/api/auth/passkey/login/verify`, { method: opts.method ?? 'POST', headers });
}

interface Opts {
  rpHash?: Buffer;
  flags?: number;
  origin?: string;
  type?: string;
  pair?: crypto.KeyPairKeyObjectResult;
  raw?: boolean;
  id?: string;
}

function assertion(challenge: string, o: Opts = {}) {
  const authData = Buffer.concat([o.rpHash ?? sha256('tv-eg.com'), Buffer.from([o.flags ?? 0x05]), Buffer.alloc(4)]);
  const clientData = Buffer.from(
    JSON.stringify({ type: o.type ?? 'webauthn.get', challenge, origin: o.origin ?? 'https://tv-eg.com:2055', crossOrigin: false }),
  );
  const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), {
    key: (o.pair ?? keyPair).privateKey,
    dsaEncoding: o.raw ? 'ieee-p1363' : 'der',
  });
  const id = o.id ?? credId;
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: sig.toString('base64url'),
    },
  };
}

async function login(o: Opts = {}, port = '2055') {
  const begin = await pk.beginPasskeyAuthentication(makeReq({ port }));
  const chalCookie = `${remote.PANEL_WEBAUTHN_CHALLENGE_COOKIE}=${encodeURIComponent(begin.challengeCookieValue)}`;
  return {
    begin,
    result: await pk.finishPasskeyAuthentication({
      req: makeReq({ port, cookie: chalCookie }),
      response: assertion(begin.options.challenge, o) as any,
    }),
  };
}

describe('shared owner passkey: login', () => {
  it('login options: rpId tv-eg.com, the shared credential only, internal+hybrid, UV required', async () => {
    writeShared();
    const { options } = await pk.beginPasskeyAuthentication(makeReq({ port: '2055' }));
    assert.equal(options.rpId, 'tv-eg.com');
    assert.equal(options.userVerification, 'required');
    assert.equal(options.allowCredentials.length, 1);
    assert.equal(options.allowCredentials[0].id, credId);
    assert.deepEqual([...options.allowCredentials[0].transports].sort(), ['hybrid', 'internal']);
  });

  it('valid assertion (DER) logs in; a raw 64-byte signature and any port also pass', async () => {
    writeShared();
    const a = await login();
    assert.equal(a.result.credentialId, credId);
    assert.equal(a.result.rpId, 'tv-eg.com');
    await login({ raw: true });
  });

  it('only the exact origin https://tv-eg.com:2055 is accepted; any other tv-eg.com port or host is rejected', async () => {
    writeShared();
    assert.equal(sharedPk.EXPECTED_ORIGIN, 'https://tv-eg.com:2055');
    await login({ origin: 'https://tv-eg.com:2055' });
    for (const origin of ['https://tv-eg.com:8123', 'https://tv-eg.com:2091', 'https://tv-eg.com', 'https://tv-eg.com:443', 'https://sub.tv-eg.com:2055']) {
      await assert.rejects(login({ origin }), origin);
    }
  });

  it('wrong origin fails', async () => {
    writeShared();
    for (const origin of ['https://evil.example', 'http://tv-eg.com', 'https://tv-eg.com.evil.example', 'https://x.tv-eg.com']) {
      await assert.rejects(login({ origin }), origin);
    }
  });

  it('wrong rp hash, wrong key, missing UV, missing UP, wrong type, wrong credential all fail', async () => {
    writeShared();
    await assert.rejects(login({ rpHash: sha256('evil.example') }), 'rp hash');
    await assert.rejects(login({ pair: otherPair }), 'wrong key');
    await assert.rejects(login({ flags: 0x01 }), 'no UV');
    await assert.rejects(login({ flags: 0x04 }), 'no UP');
    await assert.rejects(login({ type: 'webauthn.create' }), 'type');
    await assert.rejects(login({ id: crypto.randomBytes(16).toString('base64url') }), 'credential id');
  });

  it('a challenge is single use', async () => {
    writeShared();
    const begin = await pk.beginPasskeyAuthentication(makeReq({ port: '2055' }));
    const cookie = `${remote.PANEL_WEBAUTHN_CHALLENGE_COOKIE}=${encodeURIComponent(begin.challengeCookieValue)}`;
    const response = assertion(begin.options.challenge) as any;
    await pk.finishPasskeyAuthentication({ req: makeReq({ port: '2055', cookie }), response });
    await assert.rejects(pk.finishPasskeyAuthentication({ req: makeReq({ port: '2055', cookie }), response }), 'replay');
  });

  it('missing shared file: clear error, no fallback to the old vault rows', async () => {
    writeShared();
    // An OLD vault row exists and must never count.
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO passkey_credentials (id, public_key, counter, rp_id, origin, label, created_at, revoked_at)
       VALUES (?, ?, 0, 'tv-eg.com', 'https://tv-eg.com', 'old', 1, NULL)`,
    ).run('old-vault-credential-id', Buffer.from([1, 2, 3]));
    assert.equal(remote.countActivePasskeys(), 1);
    fs.rmSync(SHARED_FILE);
    assert.equal(remote.countActivePasskeys(), 0, 'old vault row must not count');
    assert.equal(remote.hasAnyActivePasskey(), false);
    await assert.rejects(pk.beginPasskeyAuthentication(makeReq({ port: '2055' })), /البصمة المشتركة/);
    fs.writeFileSync(SHARED_FILE, '{broken');
    assert.equal(remote.countActivePasskeys(), 0);
    writeShared();
  });
});

describe('shared owner passkey: sessions', () => {
  it('a session made by the shared credential validates; other credential or missing file refuses', async () => {
    writeShared();
    const rp = remote.resolveRelyingParty(makeReq({ port: '2055' }));
    assert.equal(rp.rpID, 'tv-eg.com');
    const cookieValue = remote.createPanelSessionCookie({ credentialId: credId, rpId: rp.rpID, req: makeReq({ port: '2055' }) });
    const withCookie = () => makeReq({ port: '2055', cookie: `${remote.PANEL_COOKIE}=${encodeURIComponent(cookieValue)}`, method: 'GET' });
    assert.ok(remote.verifyAuthenticatedSession(withCookie()), 'valid session');
    // No browser tie: the same session is valid from another browser engine / OS.
    const otherBrowser = makeReq({
      port: '2055',
      cookie: `${remote.PANEL_COOKIE}=${encodeURIComponent(cookieValue)}`,
      method: 'GET',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    });
    assert.ok(remote.verifyAuthenticatedSession(otherBrowser), 'session is not tied to a browser');
    fs.rmSync(SHARED_FILE);
    assert.equal(remote.verifyAuthenticatedSession(withCookie()), null, 'no shared file');
    writeShared(crypto.randomBytes(16).toString('base64url'), otherPair);
    assert.equal(remote.verifyAuthenticatedSession(withCookie()), null, 'other credential');
    writeShared();
    assert.ok(remote.verifyAuthenticatedSession(withCookie()), 'valid again');
  });
});

describe('panel session: 400 days, sliding on a visit', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const cookieFrom = (v: string) =>
    makeReq({ port: '2055', cookie: `${remote.PANEL_COOKIE}=${encodeURIComponent(v)}`, method: 'GET' });
  const expiryOf = (hash: string) =>
    (getDb().prepare('SELECT expires_at FROM panel_sessions WHERE session_id_hash = ?').get(hash) as { expires_at: number }).expires_at;

  it('lifetime is 400 days', () => {
    assert.equal(remote.PANEL_SESSION_MAX_AGE_SECONDS, 400 * 24 * 60 * 60);
  });

  it('a live session signed with the old 14-day expiry keeps working and is replaced by a 400-day one', () => {
    writeShared();
    const rp = remote.resolveRelyingParty(makeReq({ port: '2055' }));
    const issued = remote.createPanelSessionCookie({ credentialId: credId, rpId: rp.rpID, req: makeReq({ port: '2055' }) });
    const rawToken = issued.split('.')[1]!;
    const hash = remote.sha256Hex(rawToken);
    // Rewind it to what an old session looks like: 10 days left, cookie signed with that expiry.
    const oldExp = Date.now() + 10 * DAY;
    getDb().prepare('UPDATE panel_sessions SET expires_at = ? WHERE session_id_hash = ?').run(oldExp, hash);
    const oldBody = `v2.${rawToken}.${oldExp}`;
    const oldCookie = `${oldBody}.${remote.hmacSign(oldBody)}`;

    const plain = remote.verifyAuthenticatedSession(cookieFrom(oldCookie));
    assert.ok(plain, 'old cookie still valid without a slide');
    assert.equal(plain.refreshedCookie, undefined);
    assert.equal(expiryOf(hash), oldExp, 'a plain check never writes');

    const slid = remote.verifyAuthenticatedSession(cookieFrom(oldCookie), { slide: true });
    assert.ok(slid, 'old cookie valid on its visit');
    assert.ok(slid.refreshedCookie, 'a new cookie is minted');
    assert.ok(expiryOf(hash) > Date.now() + 399 * DAY, 'database expiry moved to about 400 days');
    const fresh = remote.verifyAuthenticatedSession(cookieFrom(slid.refreshedCookie!));
    assert.ok(fresh, 'the new cookie validates');
    assert.ok(Number(slid.refreshedCookie!.split('.')[2]) > Date.now() + 399 * DAY, 'cookie signed with about 400 days');
    assert.ok(fresh.expiresAt > Date.now() + 399 * DAY);

    // Visited again straight away: nothing to extend, nothing written, no cookie sent.
    const again = remote.verifyAuthenticatedSession(cookieFrom(slid.refreshedCookie!), { slide: true });
    assert.ok(again);
    assert.equal(again.refreshedCookie, undefined);
  });

  it('a cookie a day behind the database is refreshed even when the database is current', () => {
    writeShared();
    const rp = remote.resolveRelyingParty(makeReq({ port: '2055' }));
    const issued = remote.createPanelSessionCookie({ credentialId: credId, rpId: rp.rpID, req: makeReq({ port: '2055' }) });
    const rawToken = issued.split('.')[1]!;
    const staleExp = Date.now() + 300 * DAY;
    const body = `v2.${rawToken}.${staleExp}`;
    const staleCookie = `${body}.${remote.hmacSign(body)}`;
    const slid = remote.verifyAuthenticatedSession(cookieFrom(staleCookie), { slide: true });
    assert.ok(slid?.refreshedCookie, 'stale cookie replaced');
    assert.ok(Number(slid!.refreshedCookie!.split('.')[2]) > staleExp);
  });

  it('a revoked session is never slid', () => {
    writeShared();
    const rp = remote.resolveRelyingParty(makeReq({ port: '2055' }));
    const issued = remote.createPanelSessionCookie({ credentialId: credId, rpId: rp.rpID, req: makeReq({ port: '2055' }) });
    getDb().prepare('UPDATE panel_sessions SET revoked_at = ? WHERE session_id_hash = ?').run(Date.now(), remote.sha256Hex(issued.split('.')[1]!));
    assert.equal(remote.verifyAuthenticatedSession(cookieFrom(issued), { slide: true }), null);
  });
});

describe('shared owner passkey: enrolment is closed', () => {
  it('register options, register verify and enroll-token answer 410 enrol_closed', async () => {
    writeShared();
    for (const p of ['register/options', 'register/verify', 'enroll-token']) {
      const route = await routeOf(p);
      const res = await route.POST(makeReq({ port: '2055' }));
      assert.equal(res.status, 410, p);
      const body = await res.json();
      assert.equal(body.error, 'enrol_closed', p);
    }
  });

  it('status never offers registration', async () => {
    writeShared();
    const route = await routeOf('status');
    const body = await (await route.GET(makeReq({ port: '2055', method: 'GET' }))).json();
    assert.equal(body.firstTimeSetup, false);
    assert.equal(body.totalPasskeyCount, 1);
    assert.equal(body.canRegister, false);
    assert.equal(body.enrollPreview, null);
  });
});

// ── Several stored keys (keys[]), 2026-11-11 ────────────────────────────
const pair2 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credId2 = crypto.randomBytes(16).toString('base64url');
const pem = (p: crypto.KeyPairKeyObjectResult) => p.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const key1 = () => ({ credentialId: credId, publicKeyPem: pem(keyPair), transports: ['internal', 'hybrid'] });
const key2 = (transports?: string[]) => ({ credentialId: credId2, publicKeyPem: pem(pair2), ...(transports ? { transports } : {}) });

/** keys[] file; the top-level fields mirror keys[0], as the server pushes it. */
function writeKeys(list: Array<Record<string, unknown>>) {
  fs.writeFileSync(
    SHARED_FILE,
    JSON.stringify({ credentialId: list[0]!.credentialId, publicKeyPem: list[0]!.publicKeyPem, rpId: 'tv-eg.com', keys: list }),
    { mode: 0o600 },
  );
}

function sessionCookieFor(id: string) {
  const rp = remote.resolveRelyingParty(makeReq({ port: '2055' }));
  const value = remote.createPanelSessionCookie({ credentialId: id, rpId: rp.rpID, req: makeReq({ port: '2055' }) });
  return () => makeReq({ port: '2055', cookie: `${remote.PANEL_COOKIE}=${encodeURIComponent(value)}`, method: 'GET' });
}

describe('shared owner passkeys: several stored keys', () => {
  it('(a) legacy one-key file: exactly one allowCredentials entry, key 1 logs in', async () => {
    writeShared();
    const { begin, result } = await login();
    assert.equal(begin.options.allowCredentials.length, 1);
    assert.equal(begin.options.allowCredentials[0].id, credId);
    assert.equal(result.credentialId, credId);
  });

  it('(b) keys[] file: key 1 signs and logs in', async () => {
    writeKeys([key1(), key2()]);
    const { result } = await login();
    assert.equal(result.credentialId, credId);
  });

  it('(c) keys[] file: key 2 signs, options carry both keys, its session survives the session check', async () => {
    writeKeys([key1(), key2(['usb'])]);
    const { begin, result } = await login({ id: credId2, pair: pair2 });
    const allow = begin.options.allowCredentials;
    assert.equal(allow.length, 2);
    assert.deepEqual(allow.map((a: { id: string }) => a.id), [credId, credId2]);
    assert.deepEqual([...allow[0].transports].sort(), ['hybrid', 'internal']);
    assert.deepEqual(allow[1].transports, ['usb']);
    assert.equal(result.credentialId, credId2);

    const withCookie = sessionCookieFor(credId2);
    const s = remote.verifyAuthenticatedSession(withCookie());
    assert.ok(s, 'key 2 session valid');
    assert.equal(s.credentialId, credId2);
    assert.ok(remote.verifyAuthenticatedSession(withCookie()), 'still valid on the next request');
    assert.equal(remote.countActivePasskeys(), 2);
  });

  it('a keys[] entry without transports defaults to internal+hybrid', async () => {
    writeKeys([key1(), key2()]);
    const { options } = await pk.beginPasskeyAuthentication(makeReq({ port: '2055' }));
    assert.deepEqual([...options.allowCredentials[1].transports].sort(), ['hybrid', 'internal']);
  });

  it('key 2 id signed by key 1 (and the reverse) fails', async () => {
    writeKeys([key1(), key2()]);
    await assert.rejects(login({ id: credId2, pair: keyPair }), 'key 2 id, key 1 private');
    await assert.rejects(login({ id: credId, pair: pair2 }), 'key 1 id, key 2 private');
  });

  it('(d) keys[] file: an unknown credential id is a mismatch', async () => {
    writeKeys([key1(), key2()]);
    await assert.rejects(login({ id: crypto.randomBytes(16).toString('base64url'), pair: pair2 }), /Unrecognized biometric passkey/);
  });

  it('(e) a session whose key is no longer in the file is dropped', async () => {
    writeKeys([key1(), key2()]);
    const c1 = sessionCookieFor(credId);
    const c2 = sessionCookieFor(credId2);
    assert.ok(remote.verifyAuthenticatedSession(c1()));
    assert.ok(remote.verifyAuthenticatedSession(c2()));
    writeKeys([key1()]); // key 2 removed
    assert.equal(remote.verifyAuthenticatedSession(c2()), null, 'removed key session refused');
    assert.ok(remote.verifyAuthenticatedSession(c1()), 'key 1 session kept');
  });

  it('keys[] with an incomplete entry falls back to the single top-level key', async () => {
    fs.writeFileSync(
      SHARED_FILE,
      JSON.stringify({ credentialId: credId, publicKeyPem: pem(keyPair), rpId: 'tv-eg.com', keys: [key1(), { credentialId: credId2 }] }),
    );
    const { options } = await pk.beginPasskeyAuthentication(makeReq({ port: '2055' }));
    assert.equal(options.allowCredentials.length, 1);
    await assert.rejects(login({ id: credId2, pair: pair2 }));
    writeShared();
  });
});
