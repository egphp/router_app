import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const CHALLENGE_TTL_MS = 60 * 1000;
export const SKEW_MS = 60 * 1000;
export const NONCE_TTL_MS = 120 * 1000;

const PAIR_CODE_MAX_WRONG = 5;
const CHALLENGE_MAX = 256;
const NONCE_MAX = 20_000;
const HISTORY_MAX = 200;
const LAST_SEEN_PERSIST_MS = 60 * 1000;
const MAX_ATTESTATION_BYTES = 65_536;

export const DEFAULT_APP_ATTEST_ID = '9SDH6224ZX.com.tveg.tendavault';

/**
 * Apple App Attestation Root CA (pinned; offline verification without calling Apple).
 */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const AAGUID_PROD = Buffer.from('61707061747465737400000000000000', 'hex'); // "appattest\0\0\0\0\0\0\0"
const AAGUID_DEV = Buffer.from('appattestdevelop', 'ascii');
const APPLE_ATTEST_NONCE_OID = Buffer.from('06092a864886f763640802', 'hex'); // OID 1.2.840.113635.100.8.2

export type V2AuthErrorCode =
  | 'invalid_request'
  | 'invalid_key'
  | 'missing_auth_headers'
  | 'bad_header_format'
  | 'invalid_token'
  | 'token_expired'
  | 'device_mismatch'
  | 'device_not_bound'
  | 'device_locked'
  | 'stale_timestamp'
  | 'replayed_nonce'
  | 'bad_signature'
  | 'invalid_pair_code'
  | 'pair_code_expired'
  | 'challenge_expired'
  | 'challenge_invalid'
  | 'attestation_failed'
  | 'rate_limited';

export interface V2AuthFailure {
  ok: false;
  status: number;
  error: V2AuthErrorCode;
}

export interface V2DeviceRecord {
  devId: string;
  kReqSpki: string;
  kBioSpki: string;
  attestation: {
    keyId: string;
    environment: string;
    category?: number;
    bundleVersion?: string;
    storedAt: number;
  } | null;
  boundAt: number;
  lastSeenAt: number;
}

export interface V2SessionRecord {
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  prevRefreshHash: string;
  issuedAt: number;
}

export interface V2HistoryEntry {
  at: number;
  event: string;
  devId?: string;
  actor?: string;
  reason?: string;
  replacing?: boolean;
  byDevId?: string;
  attested?: boolean;
}

interface PersistedV2State {
  version: 2;
  state: 'unbound' | 'active' | 'released' | 'reset';
  device: V2DeviceRecord | null;
  session: V2SessionRecord | null;
  history: V2HistoryEntry[];
}

export interface V2TokenBundle {
  access: string;
  refresh: string;
  expires_in: number;
  refresh_expires_in: number;
}

export interface V2StatusResponse {
  ok: true;
  state: PersistedV2State['state'];
  bound: boolean;
  deviceId: string;
  boundAt: number;
  lastSeenAt: number;
  attested: boolean;
  sessionActive: boolean;
  pairing: {
    open: boolean;
    expiresAt: number;
  };
  history: Array<{
    at: number;
    event: string;
    devId: string;
    actor: string;
    reason: string;
  }>;
}

export interface VerifyRequestInput {
  method: string;
  path: string;
  query: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  body: Buffer | Uint8Array | string | null | undefined;
}

export type VerifyRequestResult =
  | { ok: true; devId: string; accessExpiresAt: number }
  | V2AuthFailure;

export interface IosV2AuthOptions {
  statePath?: string;
  now?: () => number;
  bootMs?: number;
  onRevoke?: (devId: string) => void;
  accessTtlMs?: number;
  refreshTtlMs?: number;
  requireAppAttest?: boolean;
  appAttestId?: string;
  appAttestRootPem?: string;
}

export function defaultStatePath(): string {
  const fromEnv = (process.env.TENDA_IOS_V2_STATE_PATH ?? '').trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.config', 'egphp-owner', 'tenda-ios-v2.json');
}

export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sha256Bytes(input: string | Buffer | Uint8Array): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

function b64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function decodeBase64Strict(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || !value || value.length > maxBytes * 2) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length % 4 === 1) return null;
  const padded = normalized.length % 4 === 0
    ? normalized
    : normalized + '='.repeat(4 - (normalized.length % 4));
  const buf = Buffer.from(padded, 'base64');
  return buf.length > 0 && buf.length <= maxBytes ? buf : null;
}

export function parseP256Spki(b64: unknown): { key: crypto.KeyObject; der: Buffer } | null {
  const der = decodeBase64Strict(b64, 256);
  if (!der || der.length < 64) return null;
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return null;
    const details = key.asymmetricKeyDetails;
    if (!details || details.namedCurve !== 'prime256v1') return null;
    return { key, der };
  } catch {
    return null;
  }
}

export function deviceIdFromSpki(der: Buffer): string {
  return b64urlEncode(sha256Bytes(der));
}

/**
 * Canonical v2 signed string (OwnerDeviceAuth SPEC.md):
 * `v2\n{METHOD}\n{path}\n{raw query}\n{hex sha256(body)}\n{ts}\n{nonce}\n{hex sha256(access)}`
 */
export function canonicalString(input: {
  method: string;
  path: string;
  query: string;
  body: Buffer | Uint8Array | string | null | undefined;
  ts: string | number;
  nonce: string;
  accessToken: string;
}): string {
  const bodyBuf = Buffer.isBuffer(input.body)
    ? input.body
    : input.body instanceof Uint8Array
      ? Buffer.from(input.body)
      : Buffer.from(input.body ?? '', 'utf8');

  return [
    'v2',
    String(input.method || '').toUpperCase(),
    String(input.path || ''),
    String(input.query || ''),
    sha256Hex(bodyBuf),
    String(input.ts),
    String(input.nonce),
    sha256Hex(Buffer.from(String(input.accessToken || ''), 'utf8')),
  ].join('\n');
}

export function bioMessage(challenge: string, devId: string): Buffer {
  return Buffer.from(`${challenge}|${devId}`, 'utf8');
}

export function verifyDerSignature(publicKey: crypto.KeyObject, data: Buffer, signatureB64: unknown): boolean {
  const sig = decodeBase64Strict(signatureB64, 160);
  if (!sig) return false;
  try {
    return crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'der' }, sig);
  } catch {
    return false;
  }
}

function hashEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Best-effort permission tightening
  }
  fs.renameSync(tmp, filePath);
}

// ── Minimal strict CBOR decoder for Apple App Attest ──────────────────────────────────────────

type CborValue =
  | number
  | string
  | Buffer
  | boolean
  | null
  | CborValue[]
  | Record<string | number, unknown>;

export function decodeCbor(bin: Buffer, off = 0, depth = 0): [CborValue, number] {
  if (depth > 32) throw new Error('cbor_depth');
  if (off >= bin.length) throw new Error('cbor_short');
  const ib = bin[off]!;
  const major = ib >> 5;
  const info = ib & 0x1f;
  off += 1;

  if (info === 31) throw new Error('cbor_indefinite');

  let len = info;
  if (info > 23) {
    const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const width = widths[info];
    if (!width) throw new Error('cbor_add');
    if (off + width > bin.length) throw new Error('cbor_short');
    len = 0;
    for (let i = 0; i < width; i++) {
      len = len * 256 + bin[off + i]!;
    }
    if (!Number.isSafeInteger(len)) throw new Error('cbor_int_overflow');
    off += width;
  }

  if (major === 0) return [len, off];
  if (major === 1) return [-1 - len, off];
  if (major === 2) {
    if (off + len > bin.length) throw new Error('cbor_short');
    return [bin.subarray(off, off + len), off + len];
  }
  if (major === 3) {
    if (off + len > bin.length) throw new Error('cbor_short');
    const raw = bin.subarray(off, off + len);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return [decoded, off + len];
  }
  if (major === 4) {
    const arr: CborValue[] = [];
    for (let i = 0; i < len; i++) {
      const [val, next] = decodeCbor(bin, off, depth + 1);
      arr.push(val);
      off = next;
    }
    return [arr, off];
  }
  if (major === 5) {
    const map: Record<string | number, unknown> = Object.create(null);
    for (let i = 0; i < len; i++) {
      const [key, nextK] = decodeCbor(bin, off, depth + 1);
      const [val, nextV] = decodeCbor(bin, nextK, depth + 1);
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new Error('cbor_key');
      }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('cbor_forbidden_key');
      }
      map[key] = val;
      off = nextV;
    }
    return [map, off];
  }
  if (major === 6) {
    return decodeCbor(bin, off, depth + 1);
  }
  if (major === 7) {
    if (info === 20) return [false, off];
    if (info === 21) return [true, off];
    if (info === 22) return [null, off];
  }
  throw new Error('cbor_type');
}

function derAt(bin: Buffer, off: number): { tag: number; value: Buffer; next: number } | null {
  if (off >= bin.length) return null;
  const tag = bin[off]!;
  off += 1;
  if (off >= bin.length) return null;
  const lenByte = bin[off]!;
  off += 1;
  let len = 0;
  if (lenByte < 0x80) {
    len = lenByte;
  } else {
    const count = lenByte & 0x7f;
    if (count === 0 || count > 3 || off + count > bin.length) return null;
    for (let i = 0; i < count; i++) {
      len = len * 256 + bin[off + i]!;
    }
    off += count;
  }
  if (len < 0 || off + len > bin.length) return null;
  return { tag, value: bin.subarray(off, off + len), next: off + len };
}

function extractAppAttestNonceFromCertDer(certDer: Buffer): Buffer | null {
  const pos = certDer.indexOf(APPLE_ATTEST_NONCE_OID);
  if (pos < 0) return null;
  let p = pos + APPLE_ATTEST_NONCE_OID.length;
  if (p >= certDer.length) return null;
  // Optional critical BOOLEAN DER element (0x01 0x01 0xFF)
  if (certDer[p] === 0x01) {
    const boolElem = derAt(certDer, p);
    if (!boolElem) return null;
    p = boolElem.next;
  }
  const oct = derAt(certDer, p);
  if (!oct || oct.tag !== 0x04) return null;
  const seq = derAt(oct.value, 0);
  if (!seq || seq.tag !== 0x30) return null;
  const explicit = derAt(seq.value, 0);
  if (!explicit) return null;
  const innerOct = derAt(explicit.value, 0);
  if (!innerOct || innerOct.tag !== 0x04 || innerOct.value.length !== 32) return null;
  return innerOct.value;
}

function uncompressedP256PointFromCert(cert: crypto.X509Certificate): Buffer | null {
  try {
    const jwk = cert.publicKey.export({ format: 'jwk' }) as {
      kty?: string;
      crv?: string;
      x?: string;
      y?: string;
    };
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    if (x.length === 0 || x.length > 32 || y.length === 0 || y.length > 32) return null;
    const out = Buffer.alloc(65);
    out[0] = 0x04;
    x.copy(out, 1 + (32 - x.length));
    y.copy(out, 33 + (32 - y.length));
    return out;
  } catch {
    return null;
  }
}

export interface AppAttestVerdict {
  ok: true;
  keyId: string;
  environment: 'production' | 'development';
  category?: number;
  bundleVersion?: string;
}

export function verifyAppleAppAttest(input: {
  attestation: string;
  keyId: string;
  clientData: string;
  appId: string;
  rootPem?: string;
  nowMs?: number;
}): AppAttestVerdict | { ok: false } {
  try {
    const { attestation, keyId, clientData, appId } = input;
    if (!attestation || !keyId || !clientData || !appId) return { ok: false };
    const raw = decodeBase64Strict(attestation, MAX_ATTESTATION_BYTES);
    if (!raw || raw.length > MAX_ATTESTATION_BYTES) return { ok: false };

    const [decoded, end] = decodeCbor(raw, 0);
    if (end !== raw.length || !decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Buffer.isBuffer(decoded)) {
      return { ok: false };
    }
    const obj = decoded as Record<string, unknown>;
    if (obj.fmt !== 'apple-appattest') return { ok: false };
    const stmt = obj.attStmt as Record<string, unknown> | undefined;
    const authData = obj.authData;
    if (!stmt || typeof stmt !== 'object' || !Buffer.isBuffer(authData)) return { ok: false };

    const x5c = stmt.x5c;
    const receipt = stmt.receipt;
    if (!Array.isArray(x5c) || x5c.length < 2 || !Buffer.isBuffer(receipt) || receipt.length === 0) {
      return { ok: false };
    }
    const leafDer = x5c[0];
    const interDer = x5c[1];
    if (!Buffer.isBuffer(leafDer) || !Buffer.isBuffer(interDer) || leafDer.length === 0 || interDer.length === 0) {
      return { ok: false };
    }

    const rootCert = new crypto.X509Certificate(input.rootPem ?? APPLE_APP_ATTEST_ROOT_PEM);
    const interCert = new crypto.X509Certificate(interDer);
    const leafCert = new crypto.X509Certificate(leafDer);

    if (!rootCert.ca || !interCert.ca) {
      return { ok: false };
    }
    if (!interCert.verify(rootCert.publicKey) || !leafCert.verify(interCert.publicKey)) {
      return { ok: false };
    }

    const nowMs = input.nowMs ?? Date.now();
    const skewMs = 60_000;
    for (const cert of [leafCert, interCert, rootCert]) {
      const from = Date.parse(cert.validFrom);
      const to = Date.parse(cert.validTo);
      if (!Number.isFinite(from) || !Number.isFinite(to) || (nowMs + skewMs) < from || (nowMs - skewMs) > to) {
        return { ok: false };
      }
    }

    if (authData.length < 55) return { ok: false };
    const rpIdHash = authData.subarray(0, 32);
    const flags = authData[32]!;
    const counter = authData.readUInt32BE(33);
    const aaguid = authData.subarray(37, 53);
    const credLen = authData.readUInt16BE(53);
    if (credLen < 16 || credLen > 128 || authData.length < 55 + credLen) return { ok: false };
    const credId = authData.subarray(55, 55 + credLen);

    // AT flag (0x40) required, counter must be 0 at enrollment
    if ((flags & 0x40) === 0 || counter !== 0) return { ok: false };
    if (!crypto.timingSafeEqual(sha256Bytes(appId), rpIdHash)) return { ok: false };

    let environment: 'production' | 'development';
    if (crypto.timingSafeEqual(AAGUID_PROD, aaguid)) {
      environment = 'production';
    } else if (crypto.timingSafeEqual(AAGUID_DEV, aaguid)) {
      environment = 'development';
    } else {
      return { ok: false };
    }

    const tail = authData.subarray(55 + credLen);
    let category: number | undefined;
    let bundleVersion: string | undefined;
    let ext: Record<string, unknown> | null = null;

    if (tail.length > 0) {
      const [cbor1, pos1] = decodeCbor(tail, 0);
      if (pos1 < tail.length) {
        const [extVal, extEnd] = decodeCbor(tail, pos1);
        if (extEnd !== tail.length || !extVal || typeof extVal !== 'object' || Array.isArray(extVal) || Buffer.isBuffer(extVal)) {
          return { ok: false };
        }
        ext = extVal as Record<string, unknown>;
      } else if (
        cbor1 && typeof cbor1 === 'object' && !Array.isArray(cbor1) && !Buffer.isBuffer(cbor1) &&
        ('apple_validation_category_01' in (cbor1 as Record<string, unknown>) || 'apple_bundle_version_01' in (cbor1 as Record<string, unknown>))
      ) {
        ext = cbor1 as Record<string, unknown>;
      }
    }

    if (ext) {
      if ('apple_validation_category_01' in ext) {
        if (typeof ext.apple_validation_category_01 !== 'number' || !Number.isInteger(ext.apple_validation_category_01)) {
          return { ok: false };
        }
        const cat = ext.apple_validation_category_01;
        const allowed = environment === 'development' ? [3] : [1, 2, 4];
        if (!allowed.includes(cat)) return { ok: false };
        category = cat;
      }
      if (typeof ext.apple_bundle_version_01 === 'string' && ext.apple_bundle_version_01.length > 0) {
        bundleVersion = ext.apple_bundle_version_01;
      }
    }

    const clientDataHash = sha256Bytes(Buffer.from(clientData, 'utf8'));
    const expectedNonce = sha256Bytes(Buffer.concat([authData, clientDataHash]));
    const certNonce = extractAppAttestNonceFromCertDer(leafDer);
    if (!certNonce || !crypto.timingSafeEqual(expectedNonce, certNonce)) {
      return { ok: false };
    }

    const point = uncompressedP256PointFromCert(leafCert);
    if (!point) return { ok: false };
    const keyHash = sha256Bytes(point);

    const givenKeyId = decodeBase64Strict(keyId.trim(), 64);
    if (!givenKeyId || givenKeyId.length !== 32) return { ok: false };
    if (!crypto.timingSafeEqual(keyHash, givenKeyId) || !crypto.timingSafeEqual(keyHash, credId)) {
      return { ok: false };
    }

    return {
      ok: true,
      keyId: b64urlEncode(keyHash),
      environment,
      ...(category !== undefined ? { category } : {}),
      ...(bundleVersion !== undefined ? { bundleVersion } : {}),
    };
  } catch {
    return { ok: false };
  }
}

// ── Main OwnerDeviceAuth v2 Service ───────────────────────────────────────────────────────────

function fail(status: number, error: V2AuthErrorCode): V2AuthFailure {
  return { ok: false, status, error };
}

function getHeader(headers: VerifyRequestInput['headers'], name: string): string {
  if (headers instanceof Headers) {
    return (headers.get(name) ?? '').trim();
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return (v[0] ?? '').trim();
      return typeof v === 'string' ? v.trim() : '';
    }
  }
  return '';
}

export function createIosV2Auth(options: IosV2AuthOptions = {}) {
  const statePath = options.statePath ?? defaultStatePath();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const bootMs = Number.isFinite(options.bootMs) ? options.bootMs! : now();
  const onRevoke = typeof options.onRevoke === 'function' ? options.onRevoke : () => {};
  const accessTtlMs = Number.isFinite(options.accessTtlMs) ? options.accessTtlMs! : ACCESS_TTL_MS;
  const refreshTtlMs = Number.isFinite(options.refreshTtlMs) ? options.refreshTtlMs! : REFRESH_TTL_MS;
  const requireAppAttest =
    options.requireAppAttest !== undefined
      ? options.requireAppAttest
      : process.env.TENDA_IOS_V2_ALLOW_UNATTESTED !== '1';
  const appAttestId = options.appAttestId ?? DEFAULT_APP_ATTEST_ID;
  const appAttestRootPem = options.appAttestRootPem;

  let state: PersistedV2State = {
    version: 2,
    state: 'unbound',
    device: null,
    session: null,
    history: [],
  };
  let lastLoadedMtime = 0;

  const nonces = new Map<string, number>(); // `${devId}:${nonce}` -> expiresAt
  const challenges = new Map<string, { devId: string; expiresAt: number }>();
  let pairing: { hash: string; expiresAt: number; wrong: number; actor: string } | null = null;
  let lastPersistedSeen = 0;

  function loadIfChanged(): void {
    try {
      const st = fs.statSync(statePath);
      if (st.mtimeMs === lastLoadedMtime) return;
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<PersistedV2State>;
      if (parsed && typeof parsed === 'object' && parsed.version === 2) {
        const validStates: ReadonlyArray<PersistedV2State['state']> = ['unbound', 'active', 'released', 'reset'];
        const nextState = validStates.includes(parsed.state as PersistedV2State['state'])
          ? (parsed.state as PersistedV2State['state'])
          : 'unbound';
        const device = parsed.device && typeof parsed.device === 'object' ? (parsed.device as V2DeviceRecord) : null;
        const session = parsed.session && typeof parsed.session === 'object' ? (parsed.session as V2SessionRecord) : null;
        state = {
          version: 2,
          state: !device && nextState === 'active' ? 'unbound' : nextState,
          device,
          session: device ? session : null,
          history: Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_MAX) : [],
        };
      }
      lastLoadedMtime = st.mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' && lastLoadedMtime !== 0) {
        // State file was externally deleted: fail closed to unbound state immediately.
        state = {
          version: 2,
          state: 'unbound',
          device: null,
          session: null,
          history: [],
        };
        lastLoadedMtime = 0;
        challenges.clear();
        nonces.clear();
      }
    }
  }

  function save(): void {
    atomicWriteJson(statePath, state);
    try {
      lastLoadedMtime = fs.statSync(statePath).mtimeMs;
    } catch {
      // ignore
    }
  }

  function note(event: string, extra: Partial<V2HistoryEntry> = {}): void {
    state.history.push({ at: now(), event, ...extra });
    if (state.history.length > HISTORY_MAX) {
      state.history = state.history.slice(-HISTORY_MAX);
    }
  }

  loadIfChanged();

  function active(): V2DeviceRecord | null {
    loadIfChanged();
    return state.state === 'active' && state.device ? state.device : null;
  }

  function pruneNonces(): void {
    const t = now();
    for (const [k, exp] of nonces) {
      if (exp <= t) nonces.delete(k);
    }
    if (nonces.size > NONCE_MAX) {
      for (const k of nonces.keys()) {
        nonces.delete(k);
        if (nonces.size <= NONCE_MAX) break;
      }
    }
  }

  function pruneChallenges(): void {
    const t = now();
    for (const [k, rec] of challenges) {
      if (rec.expiresAt <= t) challenges.delete(k);
    }
    if (challenges.size > CHALLENGE_MAX) {
      for (const k of challenges.keys()) {
        challenges.delete(k);
        if (challenges.size <= CHALLENGE_MAX) break;
      }
    }
  }

  function mintSession(prevRefreshHash: string): V2TokenBundle {
    const access = b64urlEncode(crypto.randomBytes(32));
    const refresh = b64urlEncode(crypto.randomBytes(48));
    const t = now();
    state.session = {
      accessHash: sha256Hex(access),
      accessExpiresAt: t + accessTtlMs,
      refreshHash: sha256Hex(refresh),
      refreshExpiresAt: t + refreshTtlMs,
      prevRefreshHash,
      issuedAt: t,
    };
    return {
      access,
      refresh,
      expires_in: Math.floor(accessTtlMs / 1000),
      refresh_expires_in: Math.floor(refreshTtlMs / 1000),
    };
  }

  function unbind(event: 'release' | 'reset', actor: string, reason: string): V2DeviceRecord | null {
    const prev = state.device;
    note(event, {
      devId: prev ? prev.devId : '',
      actor,
      reason: reason.slice(0, 120),
    });
    state.device = null;
    state.session = null;
    state.state = event === 'release' ? 'released' : 'reset';
    pairing = null;
    challenges.clear();
    save();
    if (prev) {
      try {
        onRevoke(prev.devId);
      } catch {
        // Revoke hooks must never break unbind
      }
    }
    return prev;
  }

  function status(): V2StatusResponse {
    const dev = active();
    const t = now();
    const pairingOpen = Boolean(pairing && pairing.expiresAt > t);
    return {
      ok: true,
      state: state.state,
      bound: Boolean(dev),
      deviceId: dev ? dev.devId : '',
      boundAt: dev ? dev.boundAt : 0,
      lastSeenAt: dev ? dev.lastSeenAt || 0 : 0,
      attested: Boolean(dev && dev.attestation),
      sessionActive: Boolean(state.session && state.session.accessExpiresAt > t),
      pairing: {
        open: pairingOpen,
        expiresAt: pairingOpen && pairing ? pairing.expiresAt : 0,
      },
      history: state.history.slice(-20).map((h) => ({
        at: h.at,
        event: h.event,
        devId: h.devId ?? '',
        actor: h.actor ?? '',
        reason: h.reason ?? '',
      })),
    };
  }

  function pairOpen(actor = 'web_passkey') {
    const replacing = Boolean(active());
    const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    const expiresAt = now() + PAIR_CODE_TTL_MS;
    pairing = {
      hash: sha256Hex(code),
      expiresAt,
      wrong: 0,
      actor: String(actor || 'web_passkey'),
    };
    note('pair_open', { actor: pairing.actor, replacing });
    save();
    return {
      ok: true as const,
      code,
      expiresAt,
      expiresInSeconds: Math.floor(PAIR_CODE_TTL_MS / 1000),
      replacing,
    };
  }

  function sessionChallenge(devId: unknown): { ok: true; challenge: string; expires_in: number } | V2AuthFailure {
    if (typeof devId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(devId)) {
      return fail(400, 'invalid_request');
    }
    pruneChallenges();
    const dev = active();
    const pairingOpen = Boolean(pairing && pairing.expiresAt > now());
    if (!pairingOpen && !dev) return fail(403, 'device_not_bound');
    if (!pairingOpen && dev && dev.devId !== devId) return fail(403, 'device_mismatch');
    const challenge = b64urlEncode(crypto.randomBytes(32));
    challenges.set(challenge, { devId, expiresAt: now() + CHALLENGE_TTL_MS });
    return {
      ok: true,
      challenge,
      expires_in: Math.floor(CHALLENGE_TTL_MS / 1000),
    };
  }

  function consumeChallenge(challenge: unknown, devId: string): V2AuthFailure | null {
    if (typeof challenge !== 'string' || !challenge) return fail(400, 'challenge_invalid');
    const rec = challenges.get(challenge);
    if (!rec) return fail(401, 'challenge_invalid');
    challenges.delete(challenge); // single-use, win or lose
    if (rec.expiresAt <= now()) return fail(401, 'challenge_expired');
    if (rec.devId !== devId) return fail(403, 'challenge_invalid');
    return null;
  }

  function pairComplete(rawBody: unknown): ({ ok: true; deviceId: string } & V2TokenBundle) | V2AuthFailure {
    const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    const t = now();
    const code = typeof body.code === 'string' ? body.code.replace(/[\s-]/g, '') : '';
    if (!/^\d{8}$/.test(code)) return fail(400, 'invalid_pair_code');
    if (!pairing) return active() ? fail(409, 'device_locked') : fail(403, 'invalid_pair_code');
    if (pairing.expiresAt <= t) {
      pairing = null;
      return fail(401, 'pair_code_expired');
    }
    if (!hashEq(sha256Hex(code), pairing.hash)) {
      pairing.wrong += 1;
      if (pairing.wrong >= PAIR_CODE_MAX_WRONG) {
        pairing = null;
        note('pair_code_burned');
        save();
        return fail(429, 'rate_limited');
      }
      return fail(403, 'invalid_pair_code');
    }

    const reqKey = parseP256Spki(body.k_req_spki);
    const bioKey = parseP256Spki(body.k_bio_spki);
    if (!reqKey || !bioKey) return fail(400, 'invalid_key');

    const devId = deviceIdFromSpki(reqKey.der);
    if (typeof body.dev_id !== 'string' || body.dev_id !== devId) {
      return fail(400, 'device_mismatch');
    }

    const challengeErr = consumeChallenge(body.challenge, devId);
    if (challengeErr) return challengeErr;

    const challengeStr = String(body.challenge);
    if (!verifyDerSignature(bioKey.key, bioMessage(challengeStr, devId), body.signature)) {
      return fail(403, 'bad_signature');
    }

    let attestationRecord: V2DeviceRecord['attestation'] = null;
    const att = body.attestation && typeof body.attestation === 'object'
      ? (body.attestation as Record<string, unknown>)
      : null;

    if (requireAppAttest || att) {
      if (!att || typeof att.attestation !== 'string' || typeof att.key_id !== 'string') {
        return fail(403, 'attestation_failed');
      }
      const verdict = verifyAppleAppAttest({
        attestation: att.attestation,
        keyId: att.key_id,
        clientData: `${challengeStr}|${devId}`,
        appId: appAttestId,
        rootPem: appAttestRootPem,
        nowMs: t,
      });
      if (!verdict.ok) {
        return fail(403, 'attestation_failed');
      }
      attestationRecord = {
        keyId: verdict.keyId.slice(0, 200),
        environment: verdict.environment,
        ...(verdict.category !== undefined ? { category: verdict.category } : {}),
        ...(verdict.bundleVersion !== undefined ? { bundleVersion: verdict.bundleVersion } : {}),
        storedAt: t,
      };
    }

    const previous = active();
    if (previous) {
      note('replaced', { devId: previous.devId, actor: pairing.actor, byDevId: devId });
      try {
        onRevoke(previous.devId);
      } catch {
        // ignore
      }
    }

    state.device = {
      devId,
      kReqSpki: reqKey.der.toString('base64'),
      kBioSpki: bioKey.der.toString('base64'),
      attestation: attestationRecord,
      boundAt: t,
      lastSeenAt: t,
    };
    state.state = 'active';
    const tokens = mintSession('');
    pairing = null;
    note('pair_complete', { devId, attested: Boolean(attestationRecord) });
    save();

    return { ok: true, deviceId: devId, ...tokens };
  }

  function sessionRefresh(rawBody: unknown): ({ ok: true } & V2TokenBundle) | V2AuthFailure {
    const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    const dev = active();
    if (!dev) return fail(403, 'device_not_bound');
    if (typeof body.dev_id !== 'string' || body.dev_id !== dev.devId) {
      return fail(403, 'device_mismatch');
    }

    const challengeErr = consumeChallenge(body.challenge, dev.devId);
    if (challengeErr) return challengeErr;

    const bio = parseP256Spki(dev.kBioSpki);
    if (!bio || !verifyDerSignature(bio.key, bioMessage(String(body.challenge), dev.devId), body.signature)) {
      return fail(403, 'bad_signature');
    }

    const t = now();
    const s = state.session;
    let prev = '';

    // If a refresh token is presented, verify it (or the previous one for lost-response grace).
    // If omitted (e.g. lost pair/complete answer or cleared token cache), K_bio hardware Face ID proof mints fresh tokens.
    if (typeof body.refresh === 'string' && body.refresh.length > 0) {
      if (!s) return fail(401, 'invalid_token');
      if (s.refreshExpiresAt <= t) return fail(401, 'token_expired');
      const givenHash = sha256Hex(body.refresh);
      if (!(hashEq(givenHash, s.refreshHash) || (s.prevRefreshHash && hashEq(givenHash, s.prevRefreshHash)))) {
        return fail(401, 'invalid_token');
      }
      prev = s.refreshHash;
    } else if (s && s.refreshExpiresAt > t) {
      prev = s.refreshHash;
    }

    const tokens = mintSession(prev);
    dev.lastSeenAt = t;
    save();
    return { ok: true, ...tokens };
  }

  function release(rawBody: unknown): { ok: true; state: PersistedV2State['state'] } | V2AuthFailure {
    const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    const dev = active();
    if (!dev) return fail(403, 'device_not_bound');
    if (typeof body.dev_id !== 'string' || body.dev_id !== dev.devId) {
      return fail(403, 'device_mismatch');
    }

    const challengeErr = consumeChallenge(body.challenge, dev.devId);
    if (challengeErr) return challengeErr;

    const bio = parseP256Spki(dev.kBioSpki);
    if (!bio || !verifyDerSignature(bio.key, bioMessage(String(body.challenge), dev.devId), body.signature)) {
      return fail(403, 'bad_signature');
    }

    unbind('release', 'owner_ios_app', 'released from the phone');
    return { ok: true, state: state.state };
  }

  function reset(opts: { actor?: string; reason?: string } = {}): {
    ok: true;
    state: PersistedV2State['state'];
    hadDevice: boolean;
  } {
    const had = Boolean(active());
    const actor = String(opts.actor || 'web_passkey');
    const reason = String(opts.reason || 'reset by owner');
    if (!had) {
      note('reset_unbound', { actor, reason: reason.slice(0, 120) });
      state.state = 'reset';
      state.session = null;
      pairing = null;
      challenges.clear();
      save();
      return { ok: true, state: state.state, hadDevice: false };
    }
    unbind('reset', actor, reason);
    return { ok: true, state: state.state, hadDevice: true };
  }

  function verifySignedRequest(input: VerifyRequestInput): VerifyRequestResult {
    const auth = getHeader(input.headers, 'authorization');
    const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
    const devHeader = getHeader(input.headers, 'x-dev-id');
    const tsHeader = getHeader(input.headers, 'x-dev-ts');
    const nonce = getHeader(input.headers, 'x-dev-nonce');
    const sigHeader = getHeader(input.headers, 'x-dev-sig');

    if (!bearer || !devHeader || !tsHeader || !nonce || !sigHeader) {
      return fail(401, 'missing_auth_headers');
    }
    if (!/^\d{10,16}$/.test(tsHeader) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || devHeader.length > 64) {
      return fail(401, 'bad_header_format');
    }

    const dev = active();
    if (!dev) return fail(403, 'device_not_bound');
    if (devHeader !== dev.devId) return fail(403, 'device_mismatch');

    const accessToken = bearer[1]!;
    const s = state.session;
    if (!s || !hashEq(sha256Hex(accessToken), s.accessHash)) {
      return fail(401, 'invalid_token');
    }

    const t = now();
    if (s.accessExpiresAt <= t) return fail(401, 'token_expired');

    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(t - ts) > SKEW_MS || ts < bootMs - SKEW_MS) {
      return fail(401, 'stale_timestamp');
    }

    pruneNonces();
    const nonceKey = `${dev.devId}:${nonce}`;
    if (nonces.has(nonceKey)) {
      return fail(401, 'replayed_nonce');
    }

    const reqKey = parseP256Spki(dev.kReqSpki);
    const data = Buffer.from(
      canonicalString({
        method: input.method,
        path: input.path,
        query: input.query,
        body: input.body,
        ts: tsHeader,
        nonce,
        accessToken,
      }),
      'utf8',
    );
    if (!reqKey || !verifyDerSignature(reqKey.key, data, sigHeader)) {
      return fail(403, 'bad_signature');
    }

    // Record nonce only AFTER cryptographic verification succeeds (SPEC.md)
    nonces.set(nonceKey, t + NONCE_TTL_MS);
    dev.lastSeenAt = t;
    if (t - lastPersistedSeen > LAST_SEEN_PERSIST_MS) {
      lastPersistedSeen = t;
      try {
        save();
      } catch {
        // Non-fatal telemetry write
      }
    }

    return {
      ok: true,
      devId: dev.devId,
      accessExpiresAt: s.accessExpiresAt,
    };
  }

  return {
    status,
    pairOpen,
    sessionChallenge,
    pairComplete,
    sessionRefresh,
    verifySignedRequest,
    release,
    reset,
    isBound: () => Boolean(active()),
    boundDeviceId: () => active()?.devId ?? '',
  };
}

export type IosV2AuthService = ReturnType<typeof createIosV2Auth>;

const globalForV2 = globalThis as unknown as {
  __tendaIosV2Auth?: IosV2AuthService;
  __tendaIosV2RevokeListeners?: Set<(devId: string) => void>;
};

export function onIosV2Revoke(fn: (devId: string) => void): () => void {
  if (!globalForV2.__tendaIosV2RevokeListeners) {
    globalForV2.__tendaIosV2RevokeListeners = new Set();
  }
  globalForV2.__tendaIosV2RevokeListeners.add(fn);
  return () => {
    globalForV2.__tendaIosV2RevokeListeners?.delete(fn);
  };
}

export function getIosV2Auth(): IosV2AuthService {
  if (!globalForV2.__tendaIosV2Auth) {
    globalForV2.__tendaIosV2Auth = createIosV2Auth({
      appAttestId: DEFAULT_APP_ATTEST_ID,
      onRevoke: (devId) => {
        const listeners = globalForV2.__tendaIosV2RevokeListeners;
        if (!listeners) return;
        for (const fn of listeners) {
          try {
            fn(devId);
          } catch {
            // Never let a listener interrupt revocation
          }
        }
      },
    });
  }
  return globalForV2.__tendaIosV2Auth;
}

export function resetIosV2AuthSingletonForTest(): void {
  delete globalForV2.__tendaIosV2Auth;
}
