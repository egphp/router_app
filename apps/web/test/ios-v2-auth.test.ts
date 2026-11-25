import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {};', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-ios-v2-'));
const stateFile = path.join(tmpDir, 'tenda-ios-v2.json');
process.env.DB_PATH = path.join(tmpDir, 'tenda.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.TENDA_PASSKEY_MODE = 'local_vault';
process.env.TENDA_IOS_V2_STATE_PATH = stateFile;
process.env.TENDA_IOS_V2_ALLOW_UNATTESTED = '1';

const controlPayloads: Array<Record<string, unknown>> = [];
const mockControlServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health' && req.method === 'GET') {
    res.end(JSON.stringify({ ok: true, host: '192.168.0.1' }));
    return;
  }
  if (req.url === '/device-control' && req.method === 'GET') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/device-control' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      controlPayloads.push(parsed);
      res.end(JSON.stringify({ ok: true, qos: parsed, wan: null, dhcp: null }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false }));
});

await new Promise<void>((resolve) => {
  mockControlServer.listen(0, '127.0.0.1', () => {
    const addr = mockControlServer.address();
    if (addr && typeof addr === 'object') {
      process.env.CONTROL_PORT = String(addr.port);
    }
    resolve();
  });
});

const { closeDb, getDb, runMigrations } = await import('@tenda/shared');
const {
  bioMessage,
  canonicalString,
  createIosV2Auth,
  deviceIdFromSpki,
  parseP256Spki,
  resetIosV2AuthSingletonForTest,
  sha256Hex,
  verifyAppleAppAttest,
} = await import('../lib/ios-v2-auth');
const { createPanelSessionCookie, panelSessionCookieName } = await import('../lib/remote-auth');
const { GET: v2Get, POST: v2Post } = await import('../app/api/native/v2/[...slug]/route');

const db = getDb();
runMigrations(db);

// Seed minimal test passkey + router data in SQLite
const nowSeed = Date.now();
db.prepare(
  `INSERT INTO passkey_credentials (id, public_key, counter, rp_id, origin, transports, device_type, backed_up, aaguid, label, created_at, last_used_at, revoked_at)
   VALUES (?, ?, 1, 'localhost', 'http://localhost:3030', '["internal"]', 'singleDevice', 0, NULL, 'Test Mac', ?, ?, NULL)`,
).run('cred-test-owner', Buffer.from([1, 2, 3]), nowSeed, nowSeed);

db.prepare(
  `INSERT INTO devices (mac, hostname, router_remark, custom_label, vendor, category, is_new, first_seen, last_seen, created_at, updated_at)
   VALUES ('AA:BB:CC:11:22:33', 'mac-studio', 'Studio', 'Mac Studio', 'Apple', 'computer', 1, ?, ?, ?, ?)`,
).run(nowSeed - 3600_000, nowSeed, nowSeed - 3600_000, nowSeed);

db.prepare(
  `INSERT INTO samples_raw (mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, connect_type, connection_kind, wifi_band)
   VALUES ('AA:BB:CC:11:22:33', ?, '192.168.0.10', 1, 250000, 1800000, 12000, 2, 'wired', NULL)`,
).run(nowSeed);

db.prepare(
  `INSERT INTO traffic_5min (mac, bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps)
   VALUES ('AA:BB:CC:11:22:33', ?, 524288000, 104857600, 2000000, 400000)`,
).run(nowSeed);

db.prepare(
  `INSERT INTO router_state (ts, uptime_sec, online_count, is_reboot) VALUES (?, 86400, 4, 0)`,
).run(nowSeed);

db.prepare(
  `INSERT INTO alerts (kind, mac, payload, created_at, dismissed_at) VALUES ('new_device', 'AA:BB:CC:11:22:33', 'Mac Studio joined', ?, NULL)`,
).run(nowSeed);

db.prepare(
  `INSERT INTO outages (started_at, ended_at, reason, notes) VALUES (?, ?, 'wan_drop', 'test outage')`,
).run(nowSeed - 7200_000, nowSeed - 7080_000);

after(async () => {
  resetIosV2AuthSingletonForTest();
  await new Promise<void>((resolve) => mockControlServer.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeP256Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    publicKey,
    privateKey,
    spki,
    spkiB64: spki.toString('base64'),
    devId: deviceIdFromSpki(spki),
    sign(data: Buffer): string {
      return crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
    },
  };
}

function makeSignedHeaders(opts: {
  reqKey: ReturnType<typeof makeP256Pair>;
  accessToken: string;
  method: string;
  path: string;
  query?: string;
  body?: string | Buffer;
  ts?: number;
  nonce?: string;
}) {
  const ts = String(opts.ts ?? Date.now());
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString('base64url');
  const query = opts.query ?? '';
  const bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body ?? '', 'utf8');
  const canon = canonicalString({
    method: opts.method,
    path: opts.path,
    query,
    body: bodyBuf,
    ts,
    nonce,
    accessToken: opts.accessToken,
  });
  const sig = opts.reqKey.sign(Buffer.from(canon, 'utf8'));
  return {
    Authorization: `Bearer ${opts.accessToken}`,
    'X-Dev-Id': opts.reqKey.devId,
    'X-Dev-Ts': ts,
    'X-Dev-Nonce': nonce,
    'X-Dev-Sig': sig,
  };
}

describe('OwnerDeviceAuth v2 shared vectors', () => {
  it('matches every canonical string, hash, dev_id, and signature in OwnerDeviceAuth/Tests/vectors.json', () => {
    const vectorsPath = '/Users/michaeltawfik/dev/native/ios-shared/OwnerDeviceAuth/Tests/vectors.json';
    const raw = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')) as {
      key: { public_key_spki_der_b64: string; dev_id: string };
      cases: Array<{
        name: string;
        method: string;
        path: string;
        query: string;
        body: string | null;
        ts: number;
        nonce: string;
        access_token: string;
        body_sha256_hex: string;
        access_token_sha256_hex: string;
        signed_string: string;
        signed_string_sha256_hex: string;
        signature_der_b64: string;
      }>;
    };

    const parsed = parseP256Spki(raw.key.public_key_spki_der_b64);
    assert.ok(parsed, 'SPKI should parse as EC P-256');
    assert.equal(deviceIdFromSpki(parsed.der), raw.key.dev_id);

    for (const c of raw.cases) {
      const canon = canonicalString({
        method: c.method,
        path: c.path,
        query: c.query,
        body: c.body,
        ts: c.ts,
        nonce: c.nonce,
        accessToken: c.access_token,
      });
      assert.equal(canon, c.signed_string, `${c.name}: canonical string mismatch`);
      assert.equal(sha256Hex(Buffer.from(canon, 'utf8')), c.signed_string_sha256_hex, `${c.name}: sha256 mismatch`);

      const sig = Buffer.from(c.signature_der_b64, 'base64');
      const ok = crypto.verify('sha256', Buffer.from(canon, 'utf8'), { key: parsed.key, dsaEncoding: 'der' }, sig);
      assert.equal(ok, true, `${c.name}: DER signature verification failed`);
    }
  });
});

describe('OwnerDeviceAuth v2 core engine (ios-v2-auth.ts)', () => {
  it('enforces full pair -> signed request -> refresh -> release lifecycle + security invariants', () => {
    let clock = 1_760_000_000_000;
    const revocations: string[] = [];
    const customStatePath = path.join(tmpDir, 'unit-state.json');

    const auth = createIosV2Auth({
      statePath: customStatePath,
      now: () => clock,
      bootMs: clock - 10_000,
      requireAppAttest: false,
      onRevoke: (devId) => revocations.push(devId),
    });

    const reqKey = makeP256Pair();
    const bioKey = makeP256Pair();

    // Unbound: challenge rejected when no pairing slot is open
    const chBefore = auth.sessionChallenge(reqKey.devId);
    assert.equal(chBefore.ok, false);
    if (!chBefore.ok) assert.equal(chBefore.error, 'device_not_bound');

    // Open pairing
    const opened = auth.pairOpen('passkey:owner');
    assert.equal(opened.ok, true);
    assert.match(opened.code, /^\d{8}$/);
    const stat = fs.statSync(customStatePath);
    assert.equal(stat.mode & 0o777, 0o600, 'State file must be mode 0600');

    // Challenge succeeds while pairing is open
    const ch1 = auth.sessionChallenge(reqKey.devId);
    assert.equal(ch1.ok, true);
    if (!ch1.ok) throw new Error('expected challenge');

    // Wrong code fails, does NOT burn after 1 wrong try
    const wrong = auth.pairComplete({
      code: opened.code === '00000000' ? '11111111' : '00000000',
      dev_id: reqKey.devId,
      k_req_spki: reqKey.spkiB64,
      k_bio_spki: bioKey.spkiB64,
      challenge: ch1.challenge,
      signature: bioKey.sign(bioMessage(ch1.challenge, reqKey.devId)),
    });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error, 'invalid_pair_code');

    // Complete pairing with valid code + K_bio signature
    const paired = auth.pairComplete({
      code: opened.code,
      dev_id: reqKey.devId,
      k_req_spki: reqKey.spkiB64,
      k_bio_spki: bioKey.spkiB64,
      challenge: ch1.challenge,
      signature: bioKey.sign(bioMessage(ch1.challenge, reqKey.devId)),
    });
    assert.equal(paired.ok, true);
    if (!paired.ok) throw new Error('expected pairing to succeed');
    assert.equal(paired.deviceId, reqKey.devId);
    assert.equal(paired.expires_in, 12 * 3600);
    assert.equal(paired.refresh_expires_in, 30 * 24 * 3600);

    // Persisted file stores ONLY token hashes, never raw access or refresh tokens
    const diskJson = fs.readFileSync(customStatePath, 'utf8');
    assert.ok(!diskJson.includes(paired.access), 'raw access token must never be stored on disk');
    assert.ok(!diskJson.includes(paired.refresh), 'raw refresh token must never be stored on disk');

    // Verify signed GET request
    const headers1 = makeSignedHeaders({
      reqKey,
      accessToken: paired.access,
      method: 'GET',
      path: '/api/native/v2/bootstrap',
      ts: clock,
    });
    const okReq = auth.verifySignedRequest({
      method: 'GET',
      path: '/api/native/v2/bootstrap',
      query: '',
      headers: headers1,
      body: '',
    });
    assert.equal(okReq.ok, true);

    // Replay same nonce -> 401 replayed_nonce
    const replayReq = auth.verifySignedRequest({
      method: 'GET',
      path: '/api/native/v2/bootstrap',
      query: '',
      headers: headers1,
      body: '',
    });
    assert.equal(replayReq.ok, false);
    if (!replayReq.ok) assert.equal(replayReq.error, 'replayed_nonce');

    // Tampered body with fresh nonce -> 403 bad_signature, and MUST NOT consume nonce
    const fixedNonce = crypto.randomBytes(16).toString('base64url');
    const postBody = JSON.stringify({ mac: 'AA:BB:CC:11:22:33', action: 'rename', custom_label: 'تست' });
    const postHeaders = makeSignedHeaders({
      reqKey,
      accessToken: paired.access,
      method: 'POST',
      path: '/api/native/v2/devices/control',
      body: postBody,
      ts: clock,
      nonce: fixedNonce,
    });
    const tampered = auth.verifySignedRequest({
      method: 'POST',
      path: '/api/native/v2/devices/control',
      query: '',
      headers: postHeaders,
      body: JSON.stringify({ mac: 'AA:BB:CC:11:22:33', action: 'block' }),
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.error, 'bad_signature');

    // Original untampered request with the SAME nonce still succeeds (bad sig did not consume nonce)
    const untampered = auth.verifySignedRequest({
      method: 'POST',
      path: '/api/native/v2/devices/control',
      query: '',
      headers: postHeaders,
      body: postBody,
    });
    assert.equal(untampered.ok, true);

    // Stale timestamp (> 60s skew) -> 401 stale_timestamp
    const staleHeaders = makeSignedHeaders({
      reqKey,
      accessToken: paired.access,
      method: 'GET',
      path: '/api/native/v2/bootstrap',
      ts: clock - 65_000,
    });
    const stale = auth.verifySignedRequest({
      method: 'GET',
      path: '/api/native/v2/bootstrap',
      query: '',
      headers: staleHeaders,
      body: '',
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error, 'stale_timestamp');

    // Refresh with K_bio + refresh token
    const ch2 = auth.sessionChallenge(reqKey.devId);
    assert.equal(ch2.ok, true);
    if (!ch2.ok) throw new Error('expected challenge');
    const refreshed = auth.sessionRefresh({
      dev_id: reqKey.devId,
      challenge: ch2.challenge,
      signature: bioKey.sign(bioMessage(ch2.challenge, reqKey.devId)),
      refresh: paired.refresh,
    });
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) throw new Error('expected refresh');

    // Lost-response recovery: refreshing without refresh token using K_bio alone succeeds
    const ch3 = auth.sessionChallenge(reqKey.devId);
    assert.equal(ch3.ok, true);
    if (!ch3.ok) throw new Error('expected challenge');
    const recovered = auth.sessionRefresh({
      dev_id: reqKey.devId,
      challenge: ch3.challenge,
      signature: bioKey.sign(bioMessage(ch3.challenge, reqKey.devId)),
    });
    assert.equal(recovered.ok, true);

    // Release with K_bio unbinds the device
    const ch4 = auth.sessionChallenge(reqKey.devId);
    assert.equal(ch4.ok, true);
    if (!ch4.ok) throw new Error('expected challenge');
    const released = auth.release({
      dev_id: reqKey.devId,
      challenge: ch4.challenge,
      signature: bioKey.sign(bioMessage(ch4.challenge, reqKey.devId)),
    });
    assert.equal(released.ok, true);
    assert.equal(auth.isBound(), false);
    assert.deepEqual(revocations, [reqKey.devId]);
  });

  it('rejects missing or forged App Attest when requireAppAttest is true', () => {
    const auth = createIosV2Auth({
      statePath: path.join(tmpDir, 'attest-state.json'),
      requireAppAttest: true,
    });
    const reqKey = makeP256Pair();
    const bioKey = makeP256Pair();
    const opened = auth.pairOpen('passkey:owner');
    const ch = auth.sessionChallenge(reqKey.devId);
    assert.equal(ch.ok, true);
    if (!ch.ok) throw new Error('expected challenge');

    const missingAtt = auth.pairComplete({
      code: opened.code,
      dev_id: reqKey.devId,
      k_req_spki: reqKey.spkiB64,
      k_bio_spki: bioKey.spkiB64,
      challenge: ch.challenge,
      signature: bioKey.sign(bioMessage(ch.challenge, reqKey.devId)),
    });
    assert.equal(missingAtt.ok, false);
    if (!missingAtt.ok) assert.equal(missingAtt.error, 'attestation_failed');

    const badAtt = verifyAppleAppAttest({
      attestation: Buffer.from('not-cbor').toString('base64'),
      keyId: Buffer.alloc(32, 1).toString('base64'),
      clientData: 'chal|dev',
      appId: '9SDH6224ZX.com.tveg.tendavault',
    });
    assert.equal(badAtt.ok, false);
  });

  it('verifies valid Apple App Attest CBOR + X.509 chain + OID nonce and rejects tampered attestations', () => {
    // Minimal DER helpers to synthesize real X.509v3 ECDSA P-256 certs signed by a test Root CA
    const derLen = (n: number): Buffer => {
      if (n < 0x80) return Buffer.from([n]);
      const bytes: number[] = [];
      let v = n;
      while (v > 0) {
        bytes.unshift(v & 0xff);
        v >>= 8;
      }
      return Buffer.from([0x80 | bytes.length, ...bytes]);
    };
    const derTag = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
    const derSeq = (...items: Buffer[]): Buffer => derTag(0x30, Buffer.concat(items));
    const derSet = (...items: Buffer[]): Buffer => derTag(0x31, Buffer.concat(items));
    const derInt = (n: number): Buffer => {
      let hex = n.toString(16);
      if (hex.length % 2) hex = '0' + hex;
      let buf = Buffer.from(hex, 'hex');
      if (buf[0]! & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
      return derTag(0x02, buf);
    };
    const derBitStr = (buf: Buffer): Buffer => derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
    const derUtc = (date: Date): Buffer => {
      const p = (x: number) => String(x).padStart(2, '0');
      const s = `${String(date.getUTCFullYear()).slice(-2)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
      return derTag(0x17, Buffer.from(s, 'ascii'));
    };
    const derCn = (cn: string): Buffer =>
      derSeq(derSet(derSeq(Buffer.from('0603550403', 'hex'), derTag(0x0c, Buffer.from(cn, 'utf8')))));
    const algEcdsaSha256 = derSeq(Buffer.from('06082a8648ce3d040302', 'hex'));

    function makeX509(opts: {
      serial: number;
      subjectCn: string;
      issuerCn: string;
      subjectSpki: Buffer;
      issuerPriv: crypto.KeyObject;
      notBefore: Date;
      notAfter: Date;
      isCa: boolean;
      nonce?: Buffer;
    }): Buffer {
      const exts: Buffer[] = [];
      if (opts.isCa) {
        // BasicConstraints (OID 2.5.29.19), critical=TRUE, SEQUENCE { BOOLEAN TRUE }
        exts.push(
          derSeq(
            Buffer.from('0603551d13', 'hex'),
            Buffer.from('0101ff', 'hex'),
            derTag(0x04, derSeq(Buffer.from('0101ff', 'hex'))),
          ),
        );
      }
      if (opts.nonce) {
        // Apple App Attest Nonce OID 1.2.840.113635.100.8.2 -> OCTET STRING { SEQUENCE { [1] { OCTET STRING(32) } } }
        const extVal = derSeq(derTag(0xa1, derTag(0x04, opts.nonce)));
        exts.push(derSeq(Buffer.from('06092a864886f763640802', 'hex'), derTag(0x04, extVal)));
      }
      const tbs = derSeq(
        derTag(0xa0, derInt(2)), // v3
        derInt(opts.serial),
        algEcdsaSha256,
        derCn(opts.issuerCn),
        derSeq(derUtc(opts.notBefore), derUtc(opts.notAfter)),
        derCn(opts.subjectCn),
        opts.subjectSpki,
        ...(exts.length > 0 ? [derTag(0xa3, derSeq(...exts))] : []),
      );
      const sig = crypto.sign('sha256', tbs, { key: opts.issuerPriv, dsaEncoding: 'der' });
      return derSeq(tbs, algEcdsaSha256, derBitStr(sig));
    }

    // Minimal CBOR encoder for test vector construction
    const cborHead = (major: number, len: number): Buffer => {
      if (len < 24) return Buffer.from([(major << 5) | len]);
      if (len < 256) return Buffer.from([(major << 5) | 24, len]);
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(len, 1);
      return b;
    };
    const cborInt = (n: number): Buffer => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n));
    const cborBytes = (b: Buffer): Buffer => Buffer.concat([cborHead(2, b.length), b]);
    const cborText = (s: string): Buffer => {
      const b = Buffer.from(s, 'utf8');
      return Buffer.concat([cborHead(3, b.length), b]);
    };
    const cborArr = (items: Buffer[]): Buffer => Buffer.concat([cborHead(4, items.length), ...items]);
    const cborMap = (entries: Array<[Buffer, Buffer]>): Buffer =>
      Buffer.concat([cborHead(5, entries.length), ...entries.flat()]);

    const rootPair = makeP256Pair();
    const interPair = makeP256Pair();
    const leafPair = makeP256Pair();
    const nowMs = Date.now();
    const validFrom = new Date(nowMs - 86_400_000);
    const validTo = new Date(nowMs + 86_400_000 * 365);

    const rootDer = makeX509({
      serial: 1,
      subjectCn: 'Test Apple Root',
      issuerCn: 'Test Apple Root',
      subjectSpki: rootPair.spki,
      issuerPriv: rootPair.privateKey,
      notBefore: validFrom,
      notAfter: validTo,
      isCa: true,
    });
    const rootPem = `-----BEGIN CERTIFICATE-----\n${rootDer.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

    const buildAttestation = (opts: {
      appId: string;
      clientData: string;
      environment: 'production' | 'development';
      category: number;
      counter?: number;
      interIsCa?: boolean;
      expiredLeaf?: boolean;
    }) => {
      const interDer = makeX509({
        serial: 2,
        subjectCn: 'Test Apple Inter',
        issuerCn: 'Test Apple Root',
        subjectSpki: interPair.spki,
        issuerPriv: rootPair.privateKey,
        notBefore: validFrom,
        notAfter: validTo,
        isCa: opts.interIsCa ?? true,
      });

      const jwk = leafPair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      const xBuf = Buffer.from(jwk.x, 'base64url');
      const yBuf = Buffer.from(jwk.y, 'base64url');
      const point = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
      const keyHash = crypto.createHash('sha256').update(point).digest();

      const rpIdHash = crypto.createHash('sha256').update(opts.appId).digest();
      const flags = Buffer.from([0xc0]); // AT (0x40) + ED (0x80)
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(opts.counter ?? 0, 0);
      const aaguid =
        opts.environment === 'production'
          ? Buffer.from('61707061747465737400000000000000', 'hex')
          : Buffer.from('appattestdevelop', 'ascii');
      const credLen = Buffer.alloc(2);
      credLen.writeUInt16BE(keyHash.length, 0);
      const coseKey = cborMap([
        [cborInt(1), cborInt(2)],
        [cborInt(3), cborInt(-7)],
        [cborInt(-1), cborInt(1)],
        [cborInt(-2), cborBytes(xBuf)],
        [cborInt(-3), cborBytes(yBuf)],
      ]);
      const extMap = cborMap([
        [cborText('apple_validation_category_01'), cborInt(opts.category)],
        [cborText('apple_bundle_version_01'), cborText('1.0.0')],
      ]);
      const authData = Buffer.concat([rpIdHash, flags, counter, aaguid, credLen, keyHash, coseKey, extMap]);
      const clientDataHash = crypto.createHash('sha256').update(opts.clientData, 'utf8').digest();
      const nonce = crypto.createHash('sha256').update(Buffer.concat([authData, clientDataHash])).digest();

      const leafDer = makeX509({
        serial: 3,
        subjectCn: 'Test Apple Leaf',
        issuerCn: 'Test Apple Inter',
        subjectSpki: leafPair.spki,
        issuerPriv: interPair.privateKey,
        notBefore: opts.expiredLeaf ? new Date(nowMs - 20 * 86_400_000) : validFrom,
        notAfter: opts.expiredLeaf ? new Date(nowMs - 86_400_000) : validTo,
        isCa: false,
        nonce,
      });

      const attestObj = cborMap([
        [cborText('fmt'), cborText('apple-appattest')],
        [
          cborText('attStmt'),
          cborMap([
            [cborText('x5c'), cborArr([cborBytes(leafDer), cborBytes(interDer)])],
            [cborText('receipt'), cborBytes(Buffer.from('apple-receipt-bytes'))],
          ]),
        ],
        [cborText('authData'), cborBytes(authData)],
      ]);

      return {
        attestation: attestObj.toString('base64'),
        keyId: keyHash.toString('base64'),
      };
    };

    const appId = '9SDH6224ZX.com.tveg.tendavault';
    const reqKey = makeP256Pair();
    const bioKey = makeP256Pair();
    const auth = createIosV2Auth({
      statePath: path.join(tmpDir, 'attest-positive-state.json'),
      requireAppAttest: true,
      appAttestId: appId,
      appAttestRootPem: rootPem,
    });
    const opened = auth.pairOpen('passkey:owner');
    const ch = auth.sessionChallenge(reqKey.devId);
    assert.equal(ch.ok, true);
    if (!ch.ok) throw new Error('expected challenge');

    const clientData = `${ch.challenge}|${reqKey.devId}`;
    const validProd = buildAttestation({ appId, clientData, environment: 'production', category: 2 });

    // Direct positive check
    const prodVerdict = verifyAppleAppAttest({
      attestation: validProd.attestation,
      keyId: validProd.keyId,
      clientData,
      appId,
      rootPem,
      nowMs,
    });
    assert.equal(prodVerdict.ok, true);
    if (prodVerdict.ok) {
      assert.equal(prodVerdict.environment, 'production');
      assert.equal(prodVerdict.category, 2);
      assert.equal(prodVerdict.bundleVersion, '1.0.0');
    }

    // Tampered clientData / appId / counter / category / non-CA intermediate / expired leaf MUST all fail
    assert.equal(verifyAppleAppAttest({ ...validProd, clientData: 'wrong|dev', appId, rootPem, nowMs }).ok, false);
    assert.equal(verifyAppleAppAttest({ ...validProd, clientData, appId: 'WRONG.app', rootPem, nowMs }).ok, false);
    assert.equal(
      verifyAppleAppAttest({ ...buildAttestation({ appId, clientData, environment: 'production', category: 2, counter: 1 }), clientData, appId, rootPem, nowMs }).ok,
      false,
    );
    assert.equal(
      verifyAppleAppAttest({ ...buildAttestation({ appId, clientData, environment: 'production', category: 3 }), clientData, appId, rootPem, nowMs }).ok,
      false,
    );
    assert.equal(
      verifyAppleAppAttest({ ...buildAttestation({ appId, clientData, environment: 'production', category: 2, interIsCa: false }), clientData, appId, rootPem, nowMs }).ok,
      false,
    );
    assert.equal(
      verifyAppleAppAttest({ ...buildAttestation({ appId, clientData, environment: 'production', category: 2, expiredLeaf: true }), clientData, appId, rootPem, nowMs }).ok,
      false,
    );

    // End-to-end pairComplete with requireAppAttest: true succeeds!
    const paired = auth.pairComplete({
      code: opened.code,
      dev_id: reqKey.devId,
      k_req_spki: reqKey.spkiB64,
      k_bio_spki: bioKey.spkiB64,
      challenge: ch.challenge,
      signature: bioKey.sign(bioMessage(ch.challenge, reqKey.devId)),
      attestation: {
        key_id: validProd.keyId,
        attestation: validProd.attestation,
      },
    });
    assert.equal(paired.ok, true);
    assert.equal(auth.status().attested, true);

    // External deletion of state file fails closed to unbound immediately
    fs.unlinkSync(path.join(tmpDir, 'attest-positive-state.json'));
    assert.equal(auth.isBound(), false);
  });

  it('burns pairing code after 5 wrong guesses', () => {
    const auth = createIosV2Auth({
      statePath: path.join(tmpDir, 'burn-state.json'),
      requireAppAttest: false,
    });
    const reqKey = makeP256Pair();
    const bioKey = makeP256Pair();
    const opened = auth.pairOpen('passkey:owner');
    const wrongCode = opened.code === '99999999' ? '12345678' : '99999999';

    for (let i = 1; i <= 5; i++) {
      const res = auth.pairComplete({
        code: wrongCode,
        dev_id: reqKey.devId,
        k_req_spki: reqKey.spkiB64,
        k_bio_spki: bioKey.spkiB64,
        challenge: 'unused',
        signature: 'unused',
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error, i === 5 ? 'rate_limited' : 'invalid_pair_code');
      }
    }
    assert.equal(auth.status().pairing.open, false);
  });
});

describe('/api/native/v2/[...slug] Next.js route integration', () => {
  it('enforces passkey auth + CSRF on pair/open and signed v2 auth across all operator routes', async () => {
    // 1. pair/open without passkey session -> 401
    const unauthOpen = await v2Post(
      new Request('http://localhost:3030/api/native/v2/pair/open', {
        method: 'POST',
        headers: { host: 'localhost:3030', origin: 'http://localhost:3030' },
      }),
      { params: Promise.resolve({ slug: ['pair', 'open'] }) },
    );
    assert.equal(unauthOpen.status, 401);

    // 2. pair/open with cross-origin header -> 403
    const csrfOpen = await v2Post(
      new Request('http://localhost:3030/api/native/v2/pair/open', {
        method: 'POST',
        headers: { host: 'localhost:3030', origin: 'https://evil.example' },
      }),
      { params: Promise.resolve({ slug: ['pair', 'open'] }) },
    );
    assert.equal(csrfOpen.status, 403);

    // 3. Create valid passkey session cookie for localhost
    const loginReq = new Request('http://localhost:3030/settings', { headers: { host: 'localhost:3030' } });
    const cookieVal = createPanelSessionCookie({ credentialId: 'cred-test-owner', rpId: 'localhost', req: loginReq });
    const cookieHeader = `${panelSessionCookieName(loginReq)}=${encodeURIComponent(cookieVal)}`;

    // 4. Open pairing with valid passkey session
    const openResp = await v2Post(
      new Request('http://localhost:3030/api/native/v2/pair/open', {
        method: 'POST',
        headers: { host: 'localhost:3030', origin: 'http://localhost:3030', cookie: cookieHeader },
      }),
      { params: Promise.resolve({ slug: ['pair', 'open'] }) },
    );
    assert.equal(openResp.status, 200);
    const opened = (await openResp.json()) as { ok: boolean; code: string };
    assert.equal(opened.ok, true);
    assert.match(opened.code, /^\d{8}$/);

    // 5. Complete native v2 pairing (challenge -> pair/complete)
    const reqKey = makeP256Pair();
    const bioKey = makeP256Pair();
    const chalResp = await v2Post(
      new Request('http://localhost:3030/api/native/v2/session/challenge', {
        method: 'POST',
        headers: { host: 'localhost:3030', 'content-type': 'application/json' },
        body: JSON.stringify({ dev_id: reqKey.devId }),
      }),
      { params: Promise.resolve({ slug: ['session', 'challenge'] }) },
    );
    assert.equal(chalResp.status, 200);
    const { challenge } = (await chalResp.json()) as { challenge: string };

    const pairResp = await v2Post(
      new Request('http://localhost:3030/api/native/v2/pair/complete', {
        method: 'POST',
        headers: { host: 'localhost:3030', 'content-type': 'application/json' },
        body: JSON.stringify({
          code: opened.code,
          dev_id: reqKey.devId,
          k_req_spki: reqKey.spkiB64,
          k_bio_spki: bioKey.spkiB64,
          challenge,
          signature: bioKey.sign(bioMessage(challenge, reqKey.devId)),
        }),
      }),
      { params: Promise.resolve({ slug: ['pair', 'complete'] }) },
    );
    assert.equal(pairResp.status, 200);
    const tokens = (await pairResp.json()) as { ok: boolean; access: string; refresh: string };
    assert.equal(tokens.ok, true);

    // 6. Unsigned GET /bootstrap -> 401
    const unsignedBoot = await v2Get(
      new Request('http://localhost:3030/api/native/v2/bootstrap', { headers: { host: 'localhost:3030' } }),
      { params: Promise.resolve({ slug: ['bootstrap'] }) },
    );
    assert.equal(unsignedBoot.status, 401);

    // 7. Signed GET routes all return 200 with real SQLite data (including dash-separated MAC)
    const getRoutes: Array<{ slug: string[]; query?: string }> = [
      { slug: ['bootstrap'] },
      { slug: ['devices'] },
      { slug: ['devices', 'AA-BB-CC-11-22-33'], query: 'range=today' },
      { slug: ['devices', 'AA:BB:CC:11:22:33'], query: 'range=today' },
      { slug: ['alerts'] },
      { slug: ['security'] },
      { slug: ['consumption'] },
      { slug: ['outages'] },
      { slug: ['map'] },
      { slug: ['report'], query: 'days=7' },
      { slug: ['settings'] },
      { slug: ['device-status'] },
    ];

    for (const r of getRoutes) {
      const p = `/api/native/v2/${r.slug.map(encodeURIComponent).join('/')}`;
      const fullUrl = r.query ? `http://localhost:3030${p}?${r.query}` : `http://localhost:3030${p}`;
      const hdrs = makeSignedHeaders({
        reqKey,
        accessToken: tokens.access,
        method: 'GET',
        path: p,
        query: r.query ?? '',
      });
      const resp = await v2Get(
        new Request(fullUrl, { headers: { host: 'localhost:3030', ...hdrs } }),
        { params: Promise.resolve({ slug: r.slug }) },
      );
      assert.equal(resp.status, 200, `GET ${p} should return 200`);
      const body = (await resp.json()) as Record<string, unknown>;
      assert.equal(body.ok, true, `GET ${p} should return ok: true`);
      if (r.slug[0] === 'devices' && r.slug.length === 2) {
        const dev = body.device as { bytes_today: number; bytes_total: number };
        assert.ok(dev.bytes_today > 0, 'GET /devices/:mac must hydrate real bytes_today');
        assert.ok(dev.bytes_total > 0, 'GET /devices/:mac must hydrate real bytes_total');
      }
      if (r.slug[0] === 'outages') {
        assert.equal('uptime_series' in body, false, 'GET /outages must not dump multi-MB raw uptime_series');
      }
    }

    // 8. Signed POST devices/control (rename + block + speed_limit + unblock) & alerts/ack & router/action
    const signedPost = async (slug: string[], payload: Record<string, unknown>) => {
      const p = `/api/native/v2/${slug.join('/')}`;
      const bodyStr = JSON.stringify(payload);
      return v2Post(
        new Request(`http://localhost:3030${p}`, {
          method: 'POST',
          headers: {
            host: 'localhost:3030',
            'content-type': 'application/json',
            ...makeSignedHeaders({
              reqKey,
              accessToken: tokens.access,
              method: 'POST',
              path: p,
              body: bodyStr,
            }),
          },
          body: bodyStr,
        }),
        { params: Promise.resolve({ slug }) },
      );
    };

    const renameResp = await signedPost(['devices', 'control'], {
      mac: 'AA:BB:CC:11:22:33',
      action: 'rename',
      custom_label: 'استوديو المكتب',
    });
    assert.equal(renameResp.status, 200);
    const renamed = (await renameResp.json()) as { ok: boolean; device: { label: string } };
    assert.equal(renamed.device.label, 'استوديو المكتب');

    const blockResp = await signedPost(['devices', 'control'], { mac: 'AA:BB:CC:11:22:33', action: 'block' });
    assert.equal(blockResp.status, 200);
    assert.equal(controlPayloads[controlPayloads.length - 1]?.downloadLimitKBs, 1);

    const limitResp = await signedPost(['devices', 'control'], {
      mac: 'AA:BB:CC:11:22:33',
      action: 'speed_limit',
      download_mbps: 10,
    });
    assert.equal(limitResp.status, 200);
    assert.equal(controlPayloads[controlPayloads.length - 1]?.downloadLimitKBs, 1280);

    const ackResp = await signedPost(['alerts', 'ack'], { action: 'dismiss_all' });
    assert.equal(ackResp.status, 200);

    const refreshPollResp = await signedPost(['router', 'action'], { action: 'refresh_poll' });
    assert.equal(refreshPollResp.status, 200);
    const refreshPollJson = (await refreshPollResp.json()) as { ok: boolean; poller_refreshed: boolean };
    assert.equal(refreshPollJson.ok, true);
    assert.equal(refreshPollJson.poller_refreshed, true);

    // 8b. Signed POST settings (save_thresholds) + APNs registration + replacement revokes old device APNs token
    const threshResp = await signedPost(['settings'], {
      action: 'save_thresholds',
      totalEnabled: true,
      totalLimitBytes: 500 * 1024 * 1024 * 1024,
      totalPeriod: 'month',
      deviceEnabled: true,
      deviceDefaultLimitBytes: 25 * 1024 * 1024 * 1024,
      deviceDefaultPeriod: 'today',
    });
    assert.equal(threshResp.status, 200);
    const threshJson = (await threshResp.json()) as { ok: boolean; thresholds: { totalEnabled: boolean; totalPeriod: string } };
    assert.equal(threshJson.ok, true);
    assert.equal(threshJson.thresholds.totalEnabled, true);
    assert.equal(threshJson.thresholds.totalPeriod, 'month');

    const apnsHex = 'a'.repeat(64);
    const apnsResp = await signedPost(['push', 'apns'], {
      token: apnsHex,
      environment: 'production',
      bundleId: 'com.tveg.tendavault',
    });
    assert.equal(apnsResp.status, 200);

    // Replace iPhone A with iPhone B -> iPhone A's APNs token MUST be disabled automatically via onIosV2Revoke
    const openReplace = await v2Post(
      new Request('http://localhost:3030/api/native/v2/pair/open', {
        method: 'POST',
        headers: { host: 'localhost:3030', origin: 'http://localhost:3030', cookie: cookieHeader },
      }),
      { params: Promise.resolve({ slug: ['pair', 'open'] }) },
    );
    const replaceCode = ((await openReplace.json()) as { code: string }).code;
    const reqKey2 = makeP256Pair();
    const bioKey2 = makeP256Pair();
    const ch2Resp = await v2Post(
      new Request('http://localhost:3030/api/native/v2/session/challenge', {
        method: 'POST',
        headers: { host: 'localhost:3030', 'content-type': 'application/json' },
        body: JSON.stringify({ dev_id: reqKey2.devId }),
      }),
      { params: Promise.resolve({ slug: ['session', 'challenge'] }) },
    );
    const ch2 = ((await ch2Resp.json()) as { challenge: string }).challenge;
    const pair2Resp = await v2Post(
      new Request('http://localhost:3030/api/native/v2/pair/complete', {
        method: 'POST',
        headers: { host: 'localhost:3030', 'content-type': 'application/json' },
        body: JSON.stringify({
          code: replaceCode,
          dev_id: reqKey2.devId,
          k_req_spki: reqKey2.spkiB64,
          k_bio_spki: bioKey2.spkiB64,
          challenge: ch2,
          signature: bioKey2.sign(bioMessage(ch2, reqKey2.devId)),
        }),
      }),
      { params: Promise.resolve({ slug: ['pair', 'complete'] }) },
    );
    assert.equal(pair2Resp.status, 200);
    const oldApnsRow = db
      .prepare(`SELECT disabled_at FROM apns_devices WHERE credential_id = ?`)
      .get(`ios-v2:${reqKey.devId}`) as { disabled_at: number | null } | undefined;
    assert.ok(oldApnsRow && oldApnsRow.disabled_at !== null, 'Replaced iPhone APNs token must be disabled automatically');

    // 9. Web passkey device-reset unbinds cleanly
    const resetResp = await v2Post(
      new Request('http://localhost:3030/api/native/v2/device-reset', {
        method: 'POST',
        headers: {
          host: 'localhost:3030',
          origin: 'http://localhost:3030',
          cookie: cookieHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'test unbind' }),
      }),
      { params: Promise.resolve({ slug: ['device-reset'] }) },
    );
    assert.equal(resetResp.status, 200);
    const resetJson = (await resetResp.json()) as { ok: boolean; hadDevice: boolean };
    assert.equal(resetJson.ok, true);
    assert.equal(resetJson.hadDevice, true);
  });
});
