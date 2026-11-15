import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RouterPortMappingRule } from '@tenda/shared';
import type { RouterClient } from './router-client.js';
import { isValidLanIpv4 } from './traffic-control.js';
import { log } from './logger.js';

export const WAN1_PROBE_ENDPOINTS = {
  httpsIp: '1.1.1.2',
  dnsIp: '216.239.32.10',
} as const;

export const WAN2_PROBE_ENDPOINTS = {
  httpsIp: '1.0.0.2',
  dnsIp: '216.239.34.10',
} as const;

export const DEFAULT_SSH_EXTERNAL_PORT = 22222;
export const DEFAULT_SSH_INTERNAL_PORT = 22;
export const FALLBACK_SSH_WAN2_INTERNAL_PORT = 2222;
export const DEFAULT_DDNS_REVERIFY_MS = 15 * 60 * 1000;

export interface CloudflareDdnsConfig {
  enabled: boolean;
  apiToken: string;
  zoneId: string;
  wan1Fqdn: string;
  wan2Fqdn: string;
}

export interface CloudflareDdnsWanOutcome {
  fqdn: string;
  ok: boolean;
  skipped: boolean;
  error?: string;
}

const VALID_FQDN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const VALID_ZONE_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

export function normalizeDdnsFqdn(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/\.+$/, '').toLowerCase();
  if (!cleaned || cleaned.length > 253) return '';
  return VALID_FQDN_RE.test(cleaned) ? cleaned : '';
}

export function defaultCloudflareDdnsFilePath(): string {
  return path.join(os.homedir(), '.config', 'egphp-owner', 'tenda-cloudflare-ddns.json');
}

export function loadCloudflareDdnsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  filePath?: string,
): CloudflareDdnsConfig {
  const resolvedFile =
    filePath !== undefined
      ? filePath
      : env.TENDA_CLOUDFLARE_DDNS_FILE || (env === process.env ? defaultCloudflareDdnsFilePath() : '');

  let fileJson: Partial<{
    apiToken: string;
    zoneId: string;
    wan1Fqdn: string;
    wan2Fqdn: string;
  }> = {};
  if (resolvedFile) {
    try {
      const raw = fs.readFileSync(resolvedFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        fileJson = parsed;
      }
    } catch {
      // File is optional (e.g. absent on PPETO or secondary instances)
    }
  }

  const apiToken = (env.CF_API_TOKEN ?? fileJson.apiToken ?? '').trim();
  const zoneId = (env.CF_ZONE_ID ?? fileJson.zoneId ?? '').trim();
  const wan1Fqdn = normalizeDdnsFqdn(env.CF_DDNS_WAN1_FQDN ?? fileJson.wan1Fqdn);
  const wan2Fqdn = normalizeDdnsFqdn(env.CF_DDNS_WAN2_FQDN ?? fileJson.wan2Fqdn);
  const enabled =
    apiToken.length > 0 &&
    VALID_ZONE_ID_RE.test(zoneId) &&
    (wan1Fqdn.length > 0 || wan2Fqdn.length > 0);
  return { enabled, apiToken, zoneId, wan1Fqdn, wan2Fqdn };
}

function redactSecrets(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  out = out.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  return out.slice(0, 240);
}

const KV_SSH_ENABLED = 'router.ssh_access.enabled';
const KV_SSH_TARGET_IP = 'router.ssh_access.target_ip';
const KV_SSH_EXTERNAL_PORT = 'router.ssh_access.external_port';
const KV_SSH_USER = 'router.ssh_access.ssh_user';

export interface SshAccessConfig {
  enabled: boolean;
  targetIp: string;
  externalPort: number;
  sshUser: string;
}

export function isValidPublicIpv4(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ip = value.trim();
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127 || a === 255) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

export function isValidExternalSshPort(port: unknown): port is number {
  const n = typeof port === 'number' ? port : Number(port);
  if (!Number.isInteger(n)) return false;
  return n === 22 || (n >= 1024 && n <= 65535);
}

export function parseCloudflareTraceIp(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('ip=')) continue;
    const candidate = line.slice(3).trim();
    if (isValidPublicIpv4(candidate)) return candidate;
  }
  return null;
}

export function probeCloudflareTraceHttps(targetIp: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: targetIp,
        port: 443,
        path: '/cdn-cgi/trace',
        method: 'GET',
        servername: 'cloudflare-dns.com',
        headers: {
          Host: 'cloudflare-dns.com',
          'User-Agent': 'TendaTrafficMonitor/1.0',
          Accept: 'text/plain',
          Connection: 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total <= 8192) chunks.push(c);
        });
        res.on('end', () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new Error(`HTTPS trace HTTP ${res.statusCode} from ${targetIp}`));
            return;
          }
          const parsed = parseCloudflareTraceIp(Buffer.concat(chunks).toString('utf8'));
          if (!parsed) {
            reject(new Error(`No valid public IPv4 in trace from ${targetIp}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`HTTPS trace timeout (${timeoutMs}ms) to ${targetIp}`));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function probeGoogleMyAddrDns(dnsServerIp: string, timeoutMs = 4000): Promise<string | null> {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([dnsServerIp]);
  const records = await resolver.resolveTxt('o-o.myaddr.l.google.com');
  for (const parts of records) {
    const joined = parts.join('').replace(/^"+|"+$/g, '').trim();
    if (isValidPublicIpv4(joined)) {
      return joined;
    }
  }
  return null;
}

export function safeCurrentUsername(): string {
  try {
    const u = os.userInfo().username.trim();
    if (/^[a-zA-Z0-9._-]{1,64}$/.test(u)) return u;
  } catch {
    // ignore
  }
  return 'admin';
}

export function detectLocalLanIpv4(routerHost?: string): string | null {
  const prefix =
    routerHost && net.isIPv4(routerHost)
      ? routerHost.split('.').slice(0, 3).join('.') + '.'
      : null;

  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.internal || addr.family !== 'IPv4') continue;
      // Skip /32 secondary VIP aliases (.241/.242 symmetric SSH VIPs) when detecting primary LAN IP
      if (addr.netmask === '255.255.255.255' || addr.address.endsWith('.241') || addr.address.endsWith('.242')) continue;
      if (!isValidLanIpv4(addr.address)) continue;
      if (prefix && addr.address.startsWith(prefix)) {
        return addr.address;
      }
      candidates.push(addr.address);
    }
  }
  return candidates[0] ?? null;
}

export function listLocalIpv4Set(): Set<string> {
  const out = new Set<string>(['127.0.0.1']);
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.family === 'IPv4' && addr.address) {
        out.add(addr.address);
      }
    }
  }
  return out;
}

export interface SymmetricSshVips {
  wan1Ip: string;
  wan2Ip: string;
  wan1Vip: string;
  wan2Vip: string;
  symmetricVipsActive: boolean;
}

/**
 * Tenda W30E's Multi-WAN routes return packets purely by LAN source IP (no connmark on DNAT).
 * When secondary /32 VIP aliases `<subnet>.241` and `<subnet>.242` exist on the local Mac interface,
 * we forward `WAN1 -> .241:22` (pinned via `SSH_WAN1` to `WAN1`) and `WAN2 -> .242:22` (pinned via
 * `SSH_WAN2` to `WAN2`) while keeping the Mac's primary IP (`.7`) on Smart Load Balancing (`auto`).
 */
export function resolveSymmetricSshVips(
  targetIp: string,
  localIps: Set<string> = listLocalIpv4Set(),
): SymmetricSshVips {
  const ip = targetIp.trim();
  if (!isValidLanIpv4(ip)) {
    return { wan1Ip: ip, wan2Ip: ip, wan1Vip: ip, wan2Vip: ip, symmetricVipsActive: false };
  }
  const prefix = ip.split('.').slice(0, 3).join('.');
  const wan1Vip = `${prefix}.241`;
  const wan2Vip = `${prefix}.242`;
  const active = localIps.has(ip) && localIps.has(wan1Vip) && localIps.has(wan2Vip);
  return {
    wan1Ip: active ? wan1Vip : ip,
    wan2Ip: active ? wan2Vip : ip,
    wan1Vip,
    wan2Vip,
    symmetricVipsActive: active,
  };
}

export function isLocalIpv4(ip: string): boolean {
  const trimmed = ip.trim();
  if (!net.isIPv4(trimmed)) return false;
  if (trimmed === '127.0.0.1') return true;
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.family === 'IPv4' && addr.address === trimmed) return true;
    }
  }
  return false;
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!hasTable(db, tableName)) return false;
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

export function getSshAccessConfig(db: Database.Database, routerHost?: string): SshAccessConfig {
  const fallbackIp = detectLocalLanIpv4(routerHost) ?? '';
  const fallbackUser = safeCurrentUsername();
  if (!hasTable(db, 'kv')) {
    return {
      enabled: false,
      targetIp: fallbackIp,
      externalPort: DEFAULT_SSH_EXTERNAL_PORT,
      sshUser: fallbackUser,
    };
  }
  const rows = db
    .prepare(`SELECT key, value FROM kv WHERE key IN (?, ?, ?, ?)`)
    .all(KV_SSH_ENABLED, KV_SSH_TARGET_IP, KV_SSH_EXTERNAL_PORT, KV_SSH_USER) as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const rawEn = map.get(KV_SSH_ENABLED);
  const enabled = rawEn === '1' || rawEn === 'true';

  const rawIp = (map.get(KV_SSH_TARGET_IP) ?? '').trim();
  const targetIp = isValidLanIpv4(rawIp) ? rawIp : fallbackIp;

  const rawPort = Number(map.get(KV_SSH_EXTERNAL_PORT));
  const externalPort = isValidExternalSshPort(rawPort) ? rawPort : DEFAULT_SSH_EXTERNAL_PORT;

  const rawUser = (map.get(KV_SSH_USER) ?? '').trim();
  const sshUser = /^[a-zA-Z0-9._-]{1,64}$/.test(rawUser) ? rawUser : fallbackUser;

  return { enabled, targetIp, externalPort, sshUser };
}

export function setSshAccessConfig(
  db: Database.Database,
  patch: Partial<SshAccessConfig>,
  routerHost?: string,
): SshAccessConfig {
  const current = getSshAccessConfig(db, routerHost);
  const next: SshAccessConfig = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    targetIp:
      patch.targetIp !== undefined && isValidLanIpv4(patch.targetIp)
        ? patch.targetIp.trim()
        : current.targetIp,
    externalPort:
      patch.externalPort !== undefined && isValidExternalSshPort(patch.externalPort)
        ? Number(patch.externalPort)
        : current.externalPort,
    sshUser:
      patch.sshUser !== undefined && /^[a-zA-Z0-9._-]{1,64}$/.test(patch.sshUser.trim())
        ? patch.sshUser.trim()
        : current.sshUser,
  };

  const upsert = db.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const txn = db.transaction(() => {
    upsert.run(KV_SSH_ENABLED, next.enabled ? '1' : '0');
    upsert.run(KV_SSH_TARGET_IP, next.targetIp);
    upsert.run(KV_SSH_EXTERNAL_PORT, String(next.externalPort));
    upsert.run(KV_SSH_USER, next.sshUser);
  });
  txn();
  return next;
}

export function syncPortMappingsToDb(
  db: Database.Database,
  mappings: RouterPortMappingRule[],
  now = Date.now(),
): void {
  if (!hasTable(db, 'router_port_mappings')) return;
  const upsert = db.prepare(`
    INSERT INTO router_port_mappings (id, wan_id, server_ip, internal_port, external_port, protocol, enabled, updated_at)
    VALUES (@id, @wan_id, @server_ip, @internal_port, @external_port, @protocol, @enabled, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      wan_id = excluded.wan_id,
      server_ip = excluded.server_ip,
      internal_port = excluded.internal_port,
      external_port = excluded.external_port,
      protocol = excluded.protocol,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  const deleteMissing = db.prepare(`
    DELETE FROM router_port_mappings WHERE id NOT IN (SELECT value FROM json_each(?))
  `);
  const ids = mappings.map((m) => m.id);
  const txn = db.transaction(() => {
    for (const m of mappings) {
      upsert.run({
        id: m.id,
        wan_id: m.wanId,
        server_ip: m.serverIp,
        internal_port: m.internalPort,
        external_port: m.externalPort,
        protocol: m.protocol,
        enabled: m.enabled ? 1 : 0,
        updated_at: now,
      });
    }
    deleteMissing.run(JSON.stringify(ids));
  });
  txn();
}

export interface SyncCloudflareWanDnsOptions {
  now?: number;
  force?: boolean;
  reverifyIntervalMs?: number;
  fetchFn?: typeof fetch;
}

export async function syncCloudflareWanDns(
  db: Database.Database,
  cfg: CloudflareDdnsConfig = loadCloudflareDdnsConfigFromEnv(),
  opts: SyncCloudflareWanDnsOptions = {},
): Promise<{ synced: boolean; updated: Map<number, CloudflareDdnsWanOutcome> }> {
  const updated = new Map<number, CloudflareDdnsWanOutcome>();
  if (!cfg.enabled || !hasColumn(db, 'router_wan_ports', 'ddns_fqdn')) {
    return { synced: false, updated };
  }

  const now = opts.now ?? Date.now();
  const force = Boolean(opts.force);
  const reverifyMs = opts.reverifyIntervalMs ?? DEFAULT_DDNS_REVERIFY_MS;
  const fetchImpl = opts.fetchFn ?? fetch;

  const ports = db
    .prepare(`
      SELECT wan_id, wan_name, public_ip, ddns_fqdn, ddns_synced_ip, ddns_synced_at, ddns_last_error
      FROM router_wan_ports
      ORDER BY wan_id ASC
    `)
    .all() as Array<{
      wan_id: number;
      wan_name: string;
      public_ip: string | null;
      ddns_fqdn: string | null;
      ddns_synced_ip: string | null;
      ddns_synced_at: number | null;
      ddns_last_error: string | null;
    }>;

  const markOk = db.prepare(`
    UPDATE router_wan_ports
    SET ddns_fqdn = @fqdn,
        ddns_synced_ip = @ip,
        ddns_synced_at = @now,
        ddns_last_error = NULL
    WHERE wan_id = @wan_id
  `);
  const markErr = db.prepare(`
    UPDATE router_wan_ports
    SET ddns_fqdn = @fqdn,
        ddns_last_error = @err
    WHERE wan_id = @wan_id
  `);

  await Promise.all(
    ports.map(async (port) => {
      const targetFqdn = port.wan_id === 1 ? cfg.wan1Fqdn : port.wan_id === 2 ? cfg.wan2Fqdn : '';
      if (!targetFqdn) return;
      if (!isValidPublicIpv4(port.public_ip)) {
        // Persist configured FQDN visibility even if public IP has not resolved yet
        if (port.ddns_fqdn !== targetFqdn) {
          markErr.run({ wan_id: port.wan_id, fqdn: targetFqdn, err: port.ddns_last_error });
        }
        return;
      }

      const publicIp = port.public_ip;
      const isFresh =
        !force &&
        port.ddns_fqdn === targetFqdn &&
        port.ddns_synced_ip === publicIp &&
        !port.ddns_last_error &&
        port.ddns_synced_at !== null &&
        now - port.ddns_synced_at < reverifyMs;

      if (isFresh) {
        updated.set(port.wan_id, { fqdn: targetFqdn, ok: true, skipped: true });
        return;
      }

      try {
        const baseUrl = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(cfg.zoneId)}/dns_records`;
        const authHeaders = {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'application/json',
        };

        const listResp = await fetchImpl(
          `${baseUrl}?type=A&name=${encodeURIComponent(targetFqdn)}`,
          {
            method: 'GET',
            headers: authHeaders,
            signal: AbortSignal.timeout(8000),
          },
        );
        const listJson = (await listResp.json().catch(() => null)) as {
          success?: boolean;
          result?: Array<{ id: string; content: string; ttl: number; proxied: boolean }>;
          errors?: Array<{ message?: string }>;
        } | null;

        if (!listResp.ok || !listJson?.success || !Array.isArray(listJson.result)) {
          const detail = listJson?.errors?.[0]?.message ?? `HTTP ${listResp.status}`;
          throw new Error(`Cloudflare list failed: ${detail}`);
        }

        const existing = listJson.result[0];
        const desiredBody = {
          type: 'A',
          name: targetFqdn,
          content: publicIp,
          ttl: 60,
          proxied: false,
        };

        if (!existing) {
          const createResp = await fetchImpl(baseUrl, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(desiredBody),
            signal: AbortSignal.timeout(8000),
          });
          const createJson = (await createResp.json().catch(() => null)) as {
            success?: boolean;
            errors?: Array<{ message?: string }>;
          } | null;
          if (!createResp.ok || !createJson?.success) {
            const detail = createJson?.errors?.[0]?.message ?? `HTTP ${createResp.status}`;
            throw new Error(`Cloudflare create failed: ${detail}`);
          }
          log.info('wan-ddns: created DNS-Only A record', {
            wan: port.wan_name,
            fqdn: targetFqdn,
            ip: publicIp,
          });
        } else if (
          existing.content !== publicIp ||
          existing.proxied !== false ||
          Number(existing.ttl) !== 60
        ) {
          const updateResp = await fetchImpl(`${baseUrl}/${encodeURIComponent(String(existing.id))}`, {
            method: 'PUT',
            headers: authHeaders,
            body: JSON.stringify(desiredBody),
            signal: AbortSignal.timeout(8000),
          });
          const updateJson = (await updateResp.json().catch(() => null)) as {
            success?: boolean;
            errors?: Array<{ message?: string }>;
          } | null;
          if (!updateResp.ok || !updateJson?.success) {
            const detail = updateJson?.errors?.[0]?.message ?? `HTTP ${updateResp.status}`;
            throw new Error(`Cloudflare update failed: ${detail}`);
          }
          log.info('wan-ddns: updated DNS-Only A record', {
            wan: port.wan_name,
            fqdn: targetFqdn,
            ip: publicIp,
          });
        }

        markOk.run({ wan_id: port.wan_id, fqdn: targetFqdn, ip: publicIp, now });
        updated.set(port.wan_id, { fqdn: targetFqdn, ok: true, skipped: false });
      } catch (err) {
        const safeErr = redactSecrets(err instanceof Error ? err.message : String(err), [
          cfg.apiToken,
          cfg.zoneId,
        ]);
        markErr.run({ wan_id: port.wan_id, fqdn: targetFqdn, err: safeErr });
        updated.set(port.wan_id, { fqdn: targetFqdn, ok: false, skipped: false, error: safeErr });
        log.warn('wan-ddns: sync failed', { wan: port.wan_name, fqdn: targetFqdn, error: safeErr });
      }
    }),
  );

  return { synced: true, updated };
}

export interface ProbeWanPublicIpsOptions {
  now?: number;
  httpsProbeFn?: (targetIp: string) => Promise<string | null>;
  dnsProbeFn?: (dnsServerIp: string) => Promise<string | null>;
  ddnsConfig?: CloudflareDdnsConfig;
  ddnsFetchFn?: typeof fetch;
  forceDdnsSync?: boolean;
}

export async function probeWanPublicIps(
  db: Database.Database,
  router: Pick<RouterClient, 'ensureWanProbeStaticRoutes'>,
  opts: ProbeWanPublicIpsOptions = {},
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (!hasColumn(db, 'router_wan_ports', 'public_ip')) {
    return result;
  }

  try {
    await router.ensureWanProbeStaticRoutes();
  } catch (err) {
    log.debug('wan-public-ip: static route sync skipped', String(err));
  }

  const now = opts.now ?? Date.now();
  const httpsProbe = opts.httpsProbeFn ?? probeCloudflareTraceHttps;
  const dnsProbe = opts.dnsProbeFn ?? probeGoogleMyAddrDns;

  const ports = db
    .prepare(`
      SELECT wan_id, wan_name, status, public_ip, public_ip_changed_at
      FROM router_wan_ports
      ORDER BY wan_id ASC
    `)
    .all() as Array<{
      wan_id: number;
      wan_name: string;
      status: string;
      public_ip: string | null;
      public_ip_changed_at: number | null;
    }>;

  if (ports.length === 0) return result;

  const sshCfg = getSshAccessConfig(db);
  const updatePort = db.prepare(`
    UPDATE router_wan_ports
    SET public_ip = @public_ip,
        public_ip_checked_at = @checked_at,
        public_ip_changed_at = @changed_at
    WHERE wan_id = @wan_id
  `);
  const insertAlert = hasTable(db, 'alerts')
    ? db.prepare(`
        INSERT INTO alerts (kind, mac, payload, created_at)
        VALUES ('wan_ip_changed', NULL, ?, ?)
      `)
    : null;

  const rotated: Array<{ wanId: number; wanName: string; previousIp: string; publicIp: string }> = [];

  await Promise.all(
    ports.map(async (port) => {
      const connected = port.status === 'wired' || port.status === 'connected';
      if (!connected) {
        updatePort.run({
          wan_id: port.wan_id,
          public_ip: null,
          checked_at: now,
          changed_at: port.public_ip_changed_at,
        });
        result.set(port.wan_id, null);
        return;
      }

      const endpoints =
        port.wan_id === 1
          ? WAN1_PROBE_ENDPOINTS
          : port.wan_id === 2
            ? WAN2_PROBE_ENDPOINTS
            : null;
      if (!endpoints) {
        result.set(port.wan_id, port.public_ip);
        return;
      }

      let resolvedIp: string | null = null;
      try {
        resolvedIp = await httpsProbe(endpoints.httpsIp);
      } catch (err) {
        log.debug('wan-public-ip: HTTPS probe failed, trying DNS fallback', {
          wan: port.wan_name,
          err: String(err),
        });
      }

      if (!resolvedIp) {
        try {
          resolvedIp = await dnsProbe(endpoints.dnsIp);
        } catch (err) {
          log.debug('wan-public-ip: DNS fallback probe failed', {
            wan: port.wan_name,
            err: String(err),
          });
        }
      }

      if (!resolvedIp) {
        // Keep last known public_ip on transient probe blip, only bump checked_at
        updatePort.run({
          wan_id: port.wan_id,
          public_ip: port.public_ip,
          checked_at: now,
          changed_at: port.public_ip_changed_at,
        });
        result.set(port.wan_id, port.public_ip);
        return;
      }

      const changed = port.public_ip !== resolvedIp;
      const changedAt = changed ? now : (port.public_ip_changed_at ?? now);
      updatePort.run({
        wan_id: port.wan_id,
        public_ip: resolvedIp,
        checked_at: now,
        changed_at: changedAt,
      });
      result.set(port.wan_id, resolvedIp);

      if (port.public_ip && port.public_ip !== resolvedIp) {
        log.info('wan-public-ip: ISP public IP changed', {
          wan: port.wan_name,
          previousIp: port.public_ip,
          publicIp: resolvedIp,
        });
        rotated.push({
          wanId: port.wan_id,
          wanName: port.wan_name,
          previousIp: port.public_ip,
          publicIp: resolvedIp,
        });
      }
    }),
  );

  // Sync Cloudflare DNS-Only A records immediately (no-ops if CF_* env vars are absent)
  const ddnsResult = await syncCloudflareWanDns(
    db,
    opts.ddnsConfig ?? loadCloudflareDdnsConfigFromEnv(),
    {
      now,
      force: opts.forceDdnsSync,
      fetchFn: opts.ddnsFetchFn,
    },
  );

  for (const r of rotated) {
    const ddns = ddnsResult.updated.get(r.wanId);
    insertAlert?.run(
      JSON.stringify({
        wanId: r.wanId,
        wanName: r.wanName,
        previousIp: r.previousIp,
        publicIp: r.publicIp,
        ddnsFqdn: ddns?.fqdn ?? undefined,
        ddnsSynced: ddns ? ddns.ok : undefined,
        sshEnabled: sshCfg.enabled,
        sshPort: sshCfg.externalPort,
        sshUser: sshCfg.sshUser,
      }),
      now,
    );
  }

  return result;
}

/**
 * Lightweight user-space TCP stream relay (`0.0.0.0:2222 -> 127.0.0.1:22`).
 * Used only when Tenda W30E firmware rejects duplicate `porMappingtInternal: "22"`
 * across WAN1 + WAN2 rules targeting the same LAN server IP.
 * Because SSH is end-to-end encrypted and authenticated by `sshd` on `127.0.0.1:22`,
 * Key-Only enforcement (`PasswordAuthentication no`) remains 100% intact.
 */
export class SshLocalRelay {
  private server: net.Server | null = null;
  private activePort = 0;
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly listenPort = FALLBACK_SSH_WAN2_INTERNAL_PORT,
    private readonly bindHost = '0.0.0.0',
    private readonly targetPort = DEFAULT_SSH_INTERNAL_PORT,
    private readonly targetHost = '127.0.0.1',
  ) {}

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number {
    return this.activePort;
  }

  async start(): Promise<number> {
    if (this.server) return this.activePort;

    const srv = net.createServer((client) => {
      client.setNoDelay(true);
      client.setTimeout(30 * 60 * 1000);
      this.sockets.add(client);

      const upstream = net.connect(this.targetPort, this.targetHost);
      upstream.setNoDelay(true);
      upstream.setTimeout(30 * 60 * 1000);
      this.sockets.add(upstream);

      client.pipe(upstream);
      upstream.pipe(client);

      const cleanup = () => {
        this.sockets.delete(client);
        this.sockets.delete(upstream);
        if (!client.destroyed) client.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };

      client.on('error', cleanup);
      upstream.on('error', cleanup);
      client.on('timeout', cleanup);
      upstream.on('timeout', cleanup);
      client.on('close', cleanup);
      upstream.on('close', cleanup);
    });

    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(this.listenPort, this.bindHost, () => {
        srv.removeListener('error', reject);
        resolve();
      });
    });

    srv.on('error', (err) => {
      log.warn('ssh-local-relay server error', String(err));
    });

    this.server = srv;
    const addr = srv.address();
    this.activePort = typeof addr === 'object' && addr ? addr.port : this.listenPort;
    log.info('ssh-local-relay started', {
      listen: `${this.bindHost}:${this.activePort}`,
      target: `${this.targetHost}:${this.targetPort}`,
    });
    return this.activePort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.activePort = 0;
    for (const s of this.sockets) {
      if (!s.destroyed) s.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}
