import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import type Database from 'better-sqlite3';
import type { PushPayload } from './push.js';

interface ApnsRow {
  token: string;
  bundle_id: string;
  environment: string;
}

let cachedJwt: { token: string; exp: number } | null = null;

function apnsConfig(): { key: string; keyId: string; teamId: string } | null {
  const keyPath = (process.env.APNS_KEY_PATH ?? '').trim();
  const keyId = (process.env.APNS_KEY_ID ?? '').trim();
  const teamId = (process.env.APNS_TEAM_ID ?? '').trim();
  if (!keyPath || !keyId || !teamId) return null;
  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    if (!key.includes('PRIVATE KEY')) return null;
    return { key, keyId, teamId };
  } catch {
    return null;
  }
}

function providerJwt(cfg: { key: string; keyId: string; teamId: string }): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp > now + 60) return cachedJwt.token;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: now })).toString('base64url');
  const data = `${header}.${body}`;
  const signer = crypto.createSign('SHA256');
  signer.update(data);
  signer.end();
  const sig = signer.sign({ key: cfg.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = `${data}.${sig}`;
  cachedJwt = { token, exp: now + 50 * 60 };
  return token;
}

function postAlert(host: string, token: string, topic: string, jwt: string, payload: PushPayload): Promise<number> {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
      },
      url: payload.url || '/',
    });
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    let status = 0;
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.setEncoding('utf8');
    req.on('data', () => undefined);
    req.on('error', () => {
      client.close();
      resolve(0);
    });
    req.on('end', () => {
      client.close();
      resolve(status);
    });
    req.end(body);
  });
}

/** Sends the same alert the web push already built. Missing key or table is a skip, not a web-push failure. */
export async function deliverApns(
  db: Database.Database,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  const cfg = apnsConfig();
  if (!cfg) return { sent: 0, failed: 0 };
  let rows: ApnsRow[] = [];
  try {
    rows = db.prepare(
      `SELECT token, bundle_id, environment FROM apns_devices WHERE disabled_at IS NULL`,
    ).all() as ApnsRow[];
  } catch {
    return { sent: 0, failed: 0 };
  }
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const jwt = providerJwt(cfg);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const host = row.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const status = await postAlert(host, row.token, row.bundle_id, jwt, payload);
    if (status === 200) {
      sent += 1;
    } else {
      failed += 1;
      if (status === 410 || status === 400) {
        db.prepare(`UPDATE apns_devices SET disabled_at = ?, updated_at = ? WHERE token = ?`).run(
          Date.now(),
          Date.now(),
          row.token,
        );
      }
    }
  }
  return { sent, failed };
}
