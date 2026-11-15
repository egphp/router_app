import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// Isolate SQLite & session secret BEFORE importing web auth modules so production tenda.db is untouched.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-biometric-sec-'));
process.env.DB_PATH = path.join(tmpDir, 'test-biometric.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');

import { closeDb, getDb, runMigrations } from '@tenda/shared';
import {
  clientRateLimitScope,
  guardApiRequest,
  isLocalOrLanRequest,
  isStrictPrivateOrLoopbackIp,
  isValidRouterHost,
  verifySameOriginRequest,
} from '../lib/remote-auth';

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
