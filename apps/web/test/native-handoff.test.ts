import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-native-handoff-'));
process.env.DB_PATH = path.join(tmpDir, 'handoff.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.TENDA_PASSKEY_MODE = 'shared';

import { closeDb, getDb, runMigrations } from '@tenda/shared';
import { consumeNativeHandoff, issueNativeHandoff } from '../lib/native-handoff';
import { POST as exchange } from '../app/api/auth/native/exchange/route';
import { GET as handoff } from '../app/api/auth/native/handoff/route';

runMigrations(getDb());

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('native passkey handoff', () => {
  it('rejects a code that was never issued', () => {
    assert.equal(consumeNativeHandoff('a'.repeat(43)), null);
    assert.equal(consumeNativeHandoff(''), null);
    assert.equal(consumeNativeHandoff(12), null);
  });

  it('accepts a code once and refuses the replay', () => {
    const issued = issueNativeHandoff({ credentialId: 'cred-1', rpId: 'tv-eg.com' });
    const first = consumeNativeHandoff(issued.code);
    assert.deepEqual(first, { credentialId: 'cred-1', rpId: 'tv-eg.com' });
    assert.equal(consumeNativeHandoff(issued.code), null);
  });

  it('exchange without a live code stays 401', async () => {
    const res = await exchange(new Request('https://tv-eg.com:2055/api/auth/native/exchange', {
      method: 'POST',
      headers: {
        host: 'tv-eg.com:2055',
        origin: 'https://tv-eg.com:2055',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: 'b'.repeat(43) }),
    }));
    assert.equal(res.status, 401);
  });

  it('exchange of a fresh code returns the same session cookie style and burns the code', async () => {
    const issued = issueNativeHandoff({ credentialId: 'cred-2', rpId: 'localhost' });
    const res = await exchange(new Request('http://localhost:3030/api/auth/native/exchange', {
      method: 'POST',
      headers: {
        host: 'localhost:3030',
        origin: 'http://localhost:3030',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: issued.code }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json() as { ok?: boolean; cookieName?: string; sessionCookie?: string };
    assert.equal(body.ok, true);
    assert.equal(typeof body.cookieName, 'string');
    assert.match(body.sessionCookie ?? '', /^v2\./);
    const replay = await exchange(new Request('http://localhost:3030/api/auth/native/exchange', {
      method: 'POST',
      headers: {
        host: 'localhost:3030',
        origin: 'http://localhost:3030',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: issued.code }),
    }));
    assert.equal(replay.status, 401);
  });

  it('handoff without a passkey session is refused', async () => {
    const res = await handoff(new Request('https://tv-eg.com:2055/api/auth/native/handoff', {
      headers: { host: 'tv-eg.com:2055' },
    }));
    assert.equal(res.status, 401);
  });
});
