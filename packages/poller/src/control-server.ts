import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RouterClient } from './router-client.js';
import type { Sampler } from './sampler.js';
import { log } from './logger.js';
import {
  getNewDeviceAutoQosConfig,
  isValidLanIpv4,
  markDeviceAutoQosReviewed,
  setNewDeviceAutoQosConfig,
} from './traffic-control.js';
import {
  getSshAccessConfig,
  isValidExternalSshPort,
  probeWanPublicIps,
  setSshAccessConfig,
  syncPortMappingsToDb,
} from './wan-public-ip.js';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Local-only HTTP control plane. The Next.js web app talks to this server-to-server when the user
 * changes router host/password from /settings. Binds to 127.0.0.1 only and rejects browser CORS/Origin requests.
 */
export function startControlServer(
  port: number,
  router: RouterClient,
  repoRoot: string,
  sampler?: Sampler,
  db?: Database.Database,
): http.Server {
  const envPath = path.resolve(repoRoot, '.env');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Block cross-origin browser requests (Private Network Access / CSRF protection).
    // Note: Node 24 undici fetch sets `sec-fetch-mode: cors` on server-to-server calls without `origin` or `sec-fetch-site`,
    // whereas browsers always send `origin` and/or `sec-fetch-site`.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
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
      if (req.url === '/device-control' && req.method === 'GET') {
        const state = sampler
          ? await sampler.refreshTrafficControls()
          : await router.getTrafficControlState();
        if (sampler) {
          await sampler.refreshWanPublicIpsAndSsh().catch((e) => log.debug('refreshWanPublicIpsAndSsh failed', String(e)));
        } else if (db) {
          await probeWanPublicIps(db, router).catch((e) => log.debug('probeWanPublicIps failed', String(e)));
        }
        const autoQos = db ? getNewDeviceAutoQosConfig(db) : null;
        const sshAccess = db ? getSshAccessConfig(db, router.getHost()) : null;
        res.end(JSON.stringify({ ok: true, state, autoQos, sshAccess }));
        return;
      }
      if (req.url === '/wan-public-ip/refresh' && req.method === 'POST') {
        if (!db) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: 'Database handle unavailable' }));
          return;
        }
        const ips = sampler
          ? await sampler.refreshWanPublicIpsAndSsh()
          : await probeWanPublicIps(db, router);
        res.end(JSON.stringify({ ok: true, publicIps: Object.fromEntries(ips.entries()) }));
        return;
      }
      if (req.url === '/ssh-access' && req.method === 'POST') {
        if (!db) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: 'Database handle unavailable' }));
          return;
        }
        const body = await readJson(req);
        const current = getSshAccessConfig(db, router.getHost());
        const enabled = body.enabled !== undefined ? Boolean(body.enabled) : current.enabled;
        const targetIp =
          typeof body.targetIp === 'string' && body.targetIp.trim()
            ? body.targetIp.trim()
            : current.targetIp;
        const externalPort =
          body.externalPort !== undefined ? Number(body.externalPort) : current.externalPort;
        const sshUser =
          typeof body.sshUser === 'string' && body.sshUser.trim()
            ? body.sshUser.trim()
            : current.sshUser;

        if (!isValidLanIpv4(targetIp)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, code: 'INVALID_LAN_IP', error: 'A valid private LAN IPv4 address is required.' }));
          return;
        }
        if (!isValidExternalSshPort(externalPort)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, code: 'INVALID_SSH_PORT', error: 'External SSH port must be 22 or between 1024 and 65535.' }));
          return;
        }

        const applied = await router.configureSshPortMapping({
          enabled,
          targetIp,
          externalPort,
        });
        if (!applied.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, code: applied.code, error: applied.error }));
          return;
        }

        const sshAccess = setSshAccessConfig(db, { enabled, targetIp, externalPort, sshUser }, router.getHost());
        const mappings = await router.getPortMappings();
        syncPortMappingsToDb(db, mappings);
        if (sampler) {
          await sampler.reconcileSshRelay(mappings);
        }
        res.end(JSON.stringify({ ok: true, sshAccess, applied }));
        return;
      }
      if (req.url === '/auto-qos-policy' && req.method === 'POST') {
        if (!db) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: 'Database handle unavailable' }));
          return;
        }
        const body = await readJson(req);
        const updated = setNewDeviceAutoQosConfig(db, {
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
          autoReserve: body.autoReserve !== undefined ? Boolean(body.autoReserve) : undefined,
          downloadLimitKBs: body.downloadLimitKBs !== undefined ? Number(body.downloadLimitKBs) : undefined,
          uploadLimitKBs: body.uploadLimitKBs !== undefined ? Number(body.uploadLimitKBs) : undefined,
        });
        log.info('updated new-device auto-QoS policy', updated);
        res.end(JSON.stringify({ ok: true, autoQos: updated }));
        return;
      }
      if (req.url === '/device-control' && req.method === 'POST') {
        const body = await readJson(req);
        const {
          mac,
          ip,
          labelHint,
          downloadLimitKBs,
          uploadLimitKBs,
          remark,
          wanPort,
          wanGroupName,
          dhcpReserved,
        } = body as {
          mac?: unknown;
          ip?: unknown;
          labelHint?: unknown;
          downloadLimitKBs?: unknown;
          uploadLimitKBs?: unknown;
          remark?: unknown;
          wanPort?: unknown;
          wanGroupName?: unknown;
          dhcpReserved?: unknown;
        };

        const wantsQos = downloadLimitKBs !== undefined || uploadLimitKBs !== undefined;
        const wantsWan = wanPort !== undefined;
        const wantsDhcpReserve = dhcpReserved !== undefined;
        if (!wantsQos && !wantsWan && !wantsDhcpReserve) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: 'Specify speed limit, WAN port, and/or DHCP reservation to update.' }));
          return;
        }

        let qosResult: Awaited<ReturnType<typeof router.setDeviceSpeedLimit>> | null = null;
        let wanResult: Awaited<ReturnType<typeof router.setDeviceWanBinding>> | null = null;
        let dhcpResult: { reserved: boolean; ip?: string; routerId?: number } | null = null;

        if (wantsDhcpReserve) {
          if (typeof mac !== 'string' || typeof dhcpReserved !== 'boolean') {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'mac and boolean dhcpReserved are required for DHCP reservation control.' }));
            return;
          }
          if (dhcpReserved) {
            if (typeof ip !== 'string' || !ip.trim()) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, code: 'MISSING_DEVICE_IP', error: 'Device has no known LAN IPv4 address yet for DHCP reservation.' }));
              return;
            }
            const rsv = await router.setDeviceDhcpReservation({
              mac,
              ip,
              remark: typeof remark === 'string' && remark.trim()
                ? remark
                : (typeof labelHint === 'string' ? labelHint : null),
              allowUpdateIp: true,
            });
            if (!rsv.ok) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, code: rsv.code, error: rsv.error }));
              return;
            }
            dhcpResult = { reserved: true, ip: rsv.applied?.ip, routerId: rsv.applied?.routerId };
          } else {
            const rem = await router.removeDeviceDhcpReservation({ mac });
            if (!rem.ok) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, code: rem.code, error: rem.error }));
              return;
            }
            dhcpResult = { reserved: false };
          }
          if (sampler) {
            await sampler.refreshDhcpReservations();
          }
        }

        if (wantsQos) {
          if (typeof mac !== 'string' || typeof downloadLimitKBs !== 'number' || typeof uploadLimitKBs !== 'number') {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'mac, downloadLimitKBs, and uploadLimitKBs are required for speed control.' }));
            return;
          }
          qosResult = await router.setDeviceSpeedLimit({
            mac,
            downloadLimitKBs,
            uploadLimitKBs,
            remark: typeof remark === 'string' ? remark : undefined,
          });
          if (!qosResult.ok) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, code: qosResult.code, error: qosResult.error }));
            return;
          }
        }

        if (wantsWan) {
          if (typeof ip !== 'string' || typeof wanPort !== 'string') {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, code: 'MISSING_DEVICE_IP', error: 'Device has no known LAN IPv4 address yet for WAN routing.' }));
            return;
          }
          wanResult = await router.setDeviceWanBinding({
            ip,
            labelHint: typeof labelHint === 'string' ? labelHint : null,
            groupName: typeof wanGroupName === 'string' ? wanGroupName : null,
            wanPort,
          });
          if (!wanResult.ok) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, code: wanResult.code, error: wanResult.error }));
            return;
          }
        }

        const state = sampler
          ? await sampler.refreshTrafficControls()
          : await router.getTrafficControlState();
        if (db && typeof mac === 'string' && mac.trim()) {
          const macUp = mac.trim().toUpperCase();
          const now = Date.now();
          markDeviceAutoQosReviewed(db, macUp, now);
          db.prepare(`UPDATE devices SET is_new = 0, updated_at = ? WHERE mac = ? AND is_new = 1`).run(now, macUp);
          db.prepare(`UPDATE alerts SET dismissed_at = ? WHERE kind = 'new_device' AND mac = ? AND dismissed_at IS NULL`).run(now, macUp);
        }
        res.end(JSON.stringify({
          ok: true,
          qos: qosResult?.applied ?? null,
          wan: wanResult?.applied ?? null,
          dhcp: dhcpResult,
          state,
        }));
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
