import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { AuthenticatorTransport } from '@simplewebauthn/server';

/**
 * ONE SHARED OWNER PASSKEY (owner decision 2026-11-11).
 *
 * Every tv-eg.com panel accepts the owner's Apple passkeys, whose PUBLIC records
 * `{credentialId, publicKeyPem, rpId}` plus an optional `keys[]` array of
 * `{credentialId, publicKeyPem, transports}` (no `keys[]` = one key) live in a private file
 * (`~/.config/egphp-owner/owner-passkey-tv-eg.json`, override with
 * `TENDA_SHARED_PASSKEY_FILE`, read at call time).
 *
 *  - WebAuthn rpId is the constant `tv-eg.com` (rpId ignores the port).
 *  - Registration is closed for good (410 `enrol_closed`): all enrolments share one
 *    WebAuthn user id, so a `credentials.create` from any page would REPLACE the key
 *    on the phone while every server keeps the old public key.
 *  - Missing/unreadable file: login fails with a clear error. No fallback to the old
 *    `passkey_credentials` rows, which are left on disk and no longer consulted.
 */
export const SHARED_RP_ID = 'tv-eg.com';
export const SHARED_LABEL = 'Apple passkey';

export const ENROL_CLOSED_BODY = Object.freeze({
  ok: false,
  error: 'enrol_closed',
  message: 'تسجيل بصمات جديدة مقفول نهائياً: البصمة واحدة مشتركة لكل لوحات tv-eg.com',
});

export class SharedPasskeyUnavailableError extends Error {
  readonly code = 'shared_passkey_unavailable';
  constructor() {
    super('ملف البصمة المشتركة غير موجود أو غير مقروء على هذا الجهاز — الدخول متوقف');
  }
}

export const DEFAULT_TRANSPORTS = ['internal', 'hybrid'] as const;

export interface SharedKey {
  id: string;
  /** COSE_Key (EC2 / ES256 / P-256) as the library expects it. */
  cose: Uint8Array<ArrayBuffer>;
  transports: AuthenticatorTransport[];
}

export interface SharedPasskey {
  /** The first stored key (id / cose), so callers that read one key keep working. */
  id: string;
  cose: Uint8Array<ArrayBuffer>;
  /** Every stored key: `keys[]` of the file, or the one top-level key. */
  keys: SharedKey[];
}

/** The stored key whose credential id is exactly `id`, or null. */
export function sharedKeyFor(shared: SharedPasskey | null, id: unknown): SharedKey | null {
  if (!shared || typeof id !== 'string' || !id) return null;
  return shared.keys.find((k) => k.id === id) ?? null;
}

export function enrolClosedResponse(): NextResponse {
  return NextResponse.json({ ...ENROL_CLOSED_BODY }, { status: 410 });
}

export function sharedPasskeyPath(): string {
  return (
    process.env.TENDA_SHARED_PASSKEY_FILE ||
    path.join(os.homedir(), '.config', 'egphp-owner', 'owner-passkey-tv-eg.json')
  );
}

function coseFromXY(x: Buffer, y: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ]),
  );
}

const cache: { file: string; mtimeMs: number; size: number; value: SharedPasskey | null } = {
  file: '',
  mtimeMs: -1,
  size: -1,
  value: null,
};

/** One stored key entry -> SharedKey, or null when it is incomplete or not P-256. */
function parseSharedKey(e: unknown): SharedKey | null {
  try {
    if (!e || typeof e !== 'object') return null;
    const r = e as Record<string, unknown>;
    const id = String(r.credentialId ?? '').trim();
    const pem = String(r.publicKeyPem ?? '').trim();
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(id) || !pem) return null;
    const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    if (x.length !== 32 || y.length !== 32) return null;
    const t = Array.isArray(r.transports) ? r.transports.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
    return {
      id,
      cose: coseFromXY(x, y),
      transports: (t.length ? t : [...DEFAULT_TRANSPORTS]) as AuthenticatorTransport[],
    };
  } catch {
    return null;
  }
}

/** The shared record, or null when the file is missing or unreadable (cached by mtime+size). */
export function readSharedPasskey(): SharedPasskey | null {
  const file = sharedPasskeyPath();
  try {
    const st = fs.statSync(file);
    if (cache.value && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.value;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (raw.rpId && String(raw.rpId).trim().toLowerCase() !== SHARED_RP_ID) return null;
    // `keys[]` when it is a non-empty array of complete entries, otherwise the one top-level key.
    let entries: unknown[] = [raw];
    if (Array.isArray(raw.keys) && raw.keys.length > 0) {
      if (raw.keys.every((e) => parseSharedKey(e))) entries = raw.keys;
    }
    const keys: SharedKey[] = [];
    for (const e of entries) {
      const k = parseSharedKey(e);
      if (!k) return null;
      if (!keys.some((o) => o.id === k.id)) keys.push(k);
    }
    const value: SharedPasskey = { id: keys[0]!.id, cose: keys[0]!.cose, keys };
    cache.file = file;
    cache.mtimeMs = st.mtimeMs;
    cache.size = st.size;
    cache.value = value;
    return value;
  } catch {
    cache.value = null;
    return null;
  }
}

/**
 * The one origin an assertion may be made on. A constant, never read from the client:
 * the Tenda panel is reached at https://tv-eg.com:2055 only. (Direct LAN / localhost
 * use never logs in with a passkey: the rpId `tv-eg.com` cannot be used from another host.)
 */
export const EXPECTED_ORIGIN = 'https://tv-eg.com:2055';

/** The raw `origin` string the browser put in clientDataJSON, or '' (used only to log a mismatch). */
export function clientDataOrigin(clientDataJSON: unknown): string {
  try {
    if (typeof clientDataJSON !== 'string') return '';
    const cd = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { origin?: unknown };
    return cd && typeof cd.origin === 'string' ? cd.origin : '';
  } catch {
    return '';
  }
}

function derInt(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}

/** WebAuthn gives DER; accept a raw 64-byte r||s too by re-wrapping it as DER. */
export function normalizeSignature(sigB64: string): string {
  const sig = Buffer.from(sigB64, 'base64url');
  if (sig.length !== 64 || (sig[0] === 0x30 && sig[1] === 62)) return sigB64;
  const body = Buffer.concat([derInt(sig.subarray(0, 32)), derInt(sig.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
}
