import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
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
      // Skip /32 secondary VIP aliases (e.g. .241/.242 symmetric SSH VIPs) when detecting primary LAN IP
      if (addr.netmask === '255.255.255.255') continue;
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

export interface ProbeWanPublicIpsOptions {
  now?: number;
  httpsProbeFn?: (targetIp: string) => Promise<string | null>;
  dnsProbeFn?: (dnsServerIp: string) => Promise<string | null>;
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
        insertAlert?.run(
          JSON.stringify({
            wanId: port.wan_id,
            wanName: port.wan_name,
            previousIp: port.public_ip,
            publicIp: resolvedIp,
            sshEnabled: sshCfg.enabled,
            sshPort: sshCfg.externalPort,
            sshUser: sshCfg.sshUser,
          }),
          now,
        );
      }
    }),
  );

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
