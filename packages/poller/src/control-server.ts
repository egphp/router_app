import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouterClient } from './router-client.js';
import { log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Local-only HTTP control plane. The Next.js web app talks to this when the user changes
 * router host/password from /settings, runs a reboot test, etc. Binds to 127.0.0.1 only.
 */
export function startControlServer(port: number, router: RouterClient, repoRoot: string): http.Server {
  const envPath = path.resolve(repoRoot, '.env');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    try {
      if (req.url === '/health') {
        res.end(JSON.stringify({ ok: true, host: router.getHost() }));
        return;
      }
      if (req.url === '/test-credentials' && req.method === 'POST') {
        const body = await readJson(req);
        const { host, password } = body as { host?: string; password?: string };
        if (!host || !password) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'host + password required' }));
          return;
        }
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
        }).catch((e) => ({ ok: false, error: String(e) } as any));
        if (!('text' in probe)) {
          res.end(JSON.stringify({ ok: false, error: (probe as any).error ?? 'network error' }));
          return;
        }
        const t = await (probe as Response).text();
        try {
          const j = JSON.parse(t);
          if (j.auth === 0) {
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.end(JSON.stringify({ ok: false, error: `auth=${j.auth}` }));
          }
        } catch {
          res.end(JSON.stringify({ ok: false, error: `unexpected response: ${t.slice(0, 100)}` }));
        }
        return;
      }
      if (req.url === '/update-credentials' && req.method === 'POST') {
        const body = await readJson(req);
        const { host, password } = body as { host?: string; password?: string };
        if (!host || !password) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'host + password required' }));
          return;
        }
        // First verify
        const verify = await testCredentials(host, password);
        if (!verify.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: verify.error ?? 'verification failed' }));
          return;
        }
        // Persist to .env (only ROUTER_HOST + ROUTER_PASSWORD lines)
        let envContent = '';
        try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch {}
        envContent = upsertEnvLine(envContent, 'ROUTER_HOST', host);
        envContent = upsertEnvLine(envContent, 'ROUTER_PASSWORD', password);
        fs.writeFileSync(envPath, envContent, 'utf-8');
        process.env.ROUTER_HOST = host;
        process.env.ROUTER_PASSWORD = password;
        router.setCredentials(host, password);
        log.info('credentials updated via control plane', { host });
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
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('control server listening', { port });
  });
  return server;
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

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  let found = false;
  const escaped = value.replace(/\n/g, '\\n');
  const newLine = `${key}=${escaped}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
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
