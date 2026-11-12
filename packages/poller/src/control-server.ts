import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { RouterClient } from './router-client.js';
import type { Sampler } from './sampler.js';
import { log } from './logger.js';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Local-only HTTP control plane. The Next.js web app talks to this server-to-server when the user
 * changes router host/password from /settings. Binds to 127.0.0.1 only and rejects browser CORS/Origin requests.
 */
export function startControlServer(port: number, router: RouterClient, repoRoot: string, sampler?: Sampler): http.Server {
  const envPath = path.resolve(repoRoot, '.env');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Block cross-origin browser requests (Private Network Access / CSRF protection)
    if (req.headers.origin || req.headers['sec-fetch-mode']) {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: 'browser cross-origin access denied' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 405;
      res.end();
      return;
    }

    try {
      if (req.url === '/health' && req.method === 'GET') {
        res.end(JSON.stringify({ ok: true, host: router.getHost() }));
        return;
      }
      if (req.url === '/telemetry' && req.method === 'GET') {
        const t = sampler?.getTelemetry() ?? null;
        res.end(JSON.stringify({ ok: true, telemetry: t }));
        return;
      }
      if (req.url === '/test-credentials' && req.method === 'POST') {
        const body = await readJson(req);
        const { host, password } = body as { host?: unknown; password?: unknown };
        if (!isValidRouterTarget(host) || typeof password !== 'string' || !password || password.length > 256) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'valid private router host + password required' }));
          return;
        }
        const cleanHost = host.trim();
        const verify = await testCredentials(cleanHost, password);
        res.end(JSON.stringify(verify));
        return;
      }
      if (req.url === '/update-credentials' && req.method === 'POST') {
        const body = await readJson(req);
        const { host, password } = body as { host?: unknown; password?: unknown };
        if (!isValidRouterTarget(host) || typeof password !== 'string' || !password || password.length > 256) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'valid private router host + password required' }));
          return;
        }
        const cleanHost = host.trim();
        const verify = await testCredentials(cleanHost, password);
        if (!verify.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: verify.error ?? 'verification failed' }));
          return;
        }
        let envContent = '';
        try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch {}
        envContent = upsertEnvLine(envContent, 'ROUTER_HOST', cleanHost);
        envContent = upsertEnvLine(envContent, 'ROUTER_PASSWORD', password);
        const tmpPath = `${envPath}.tmp.${process.pid}`;
        fs.writeFileSync(tmpPath, envContent, { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, envPath);
        process.env.ROUTER_HOST = cleanHost;
        process.env.ROUTER_PASSWORD = password;
        router.setCredentials(cleanHost, password);
        log.info('credentials updated via control plane', { host: cleanHost });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/router-log' && req.method === 'GET') {
        const lines = await router.getSystemLog();
        res.end(JSON.stringify({ ok: true, lines }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (err) {
      log.error('control server error', String(err));
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'internal control server error' }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('control server listening', { port });
  });
  return server;
}

function isValidRouterTarget(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (/[\s/:?#@\\]/.test(trimmed)) return false;
  if (net.isIPv4(trimmed)) {
    const [a, b] = trimmed.split('.').map(Number);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    return false;
  }
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(trimmed);
}

async function testCredentials(host: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const probe = await fetch(`http://${host}/goform/module?auth&`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth: {
          password: Buffer.from(password, 'utf-8').toString('base64'),
          time: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const t = await probe.text();
    const j = JSON.parse(t);
    if (j.auth === 0) return { ok: true };
    return { ok: false, error: `auth code: ${j.auth}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  let found = false;
  const sanitized = value.replace(/[\r\n]/g, '');
  const newLine = `${key}=${sanitized}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith(`${key}=`)) {
      lines[i] = newLine;
      found = true;
      break;
    }
  }
  if (!found) {
    if (lines.length && !lines[lines.length - 1]) lines[lines.length - 1] = newLine;
    else lines.push(newLine);
  }
  return lines.join('\n');
}
