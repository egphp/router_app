import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

interface RawResp {
  status: number;
  text: string;
  setCookie: string | null;
  redirected: boolean;
}

export interface RouterLiveDevice {
  mac: string;
  ip: string | null;
  hostname: string | null;
  router_remark: string | null;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  down_sum_kb: number;
  connect_type: number | null;
  online_seconds: number | null;
}

export interface RouterLiveSnapshot {
  ts: number;
  source: 'router-direct';
  devices: RouterLiveDevice[];
  all_devices_down_bps: number;
  all_devices_up_bps: number;
  counter_down_bps: number;
  wan_down_bps: number;
  wan_up_bps: number;
  best_down_bps: number;
  best_up_bps: number;
}

let client: RouterLiveClient | null = null;
let clientKey = '';

export async function getRouterLiveSnapshot(): Promise<RouterLiveSnapshot | null> {
  const cfg = readRouterConfig();
  if (!cfg.password) return null;
  const key = `${cfg.host}\n${cfg.password}`;
  if (!client || clientKey !== key) {
    client = new RouterLiveClient(cfg.host, cfg.password);
    clientKey = key;
  }
  return client.snapshot();
}

export function mergeRouterLiveDevices<T extends {
  mac: string;
  ip?: string | null;
  online?: 0 | 1 | null;
  up_speed_bps?: number;
  down_speed_bps?: number;
  connect_type?: number | null;
  last_online_at?: number | null;
  last_seen?: number;
}>(devices: T[], live: RouterLiveSnapshot | null): T[] {
  if (!live) return devices;
  const liveByMac = new Map(live.devices.map((d) => [d.mac, d]));
  return devices.map((device) => {
    const current = liveByMac.get(device.mac.toUpperCase());
    if (!current) {
      return {
        ...device,
        online: 0 as 0 | 1,
        up_speed_bps: 0,
        down_speed_bps: 0,
      };
    }
    return {
      ...device,
      ip: current.ip ?? device.ip ?? null,
      online: current.online,
      up_speed_bps: current.up_speed_bps,
      down_speed_bps: current.down_speed_bps,
      connect_type: current.connect_type ?? device.connect_type ?? null,
      last_online_at: current.online === 1 ? live.ts : device.last_online_at ?? null,
      last_seen: current.online === 1 ? live.ts : device.last_seen,
    };
  });
}

export function mergeRouterLiveDevice<T extends {
  mac: string;
  ip?: string | null;
  online?: 0 | 1 | null;
  up_speed_bps?: number;
  down_speed_bps?: number;
  connect_type?: number | null;
  last_online_at?: number | null;
  last_seen?: number;
}>(device: T, live: RouterLiveSnapshot | null): T {
  return mergeRouterLiveDevices([device], live)[0] ?? device;
}

class RouterLiveClient {
  private cookie: string | null = null;
  private inFlightLogin: Promise<void> | null = null;
  private previousCounters = new Map<string, { ts: number; down_sum_kb: number; online_seconds: number | null }>();

  constructor(private readonly host: string, private readonly password: string) {}

  async snapshot(): Promise<RouterLiveSnapshot | null> {
    const ts = Date.now();
    const res = await this.call<{
      getNetwork?: Array<Record<string, unknown>>;
      getWanInfo?: Array<Record<string, unknown>>;
      getQosUserList?: Array<Record<string, unknown>>;
    }>(['getNetwork', 'getWanInfo', 'getQosUserList'], {
      getNetwork: '',
      getWanInfo: '',
      getQosUserList: { type: 1 },
    });

    const networkWan = sumWanFlux(res.getNetwork);
    const infoWan = sumWanFlux(res.getWanInfo);
    const wanDown = Math.max(networkWan.down, infoWan.down);
    const wanUp = Math.max(networkWan.up, infoWan.up);
    const devices = normalizeDevices(res.getQosUserList);
    const allDown = devices.reduce((sum, d) => sum + d.down_speed_bps, 0);
    const allUp = devices.reduce((sum, d) => sum + d.up_speed_bps, 0);
    const counterDown = this.counterDownBps(ts, devices);

    return {
      ts,
      source: 'router-direct',
      devices,
      all_devices_down_bps: allDown,
      all_devices_up_bps: allUp,
      counter_down_bps: counterDown,
      wan_down_bps: wanDown,
      wan_up_bps: wanUp,
      best_down_bps: Math.max(wanDown, allDown, counterDown),
      best_up_bps: Math.max(wanUp, allUp),
    };
  }

  private counterDownBps(ts: number, devices: RouterLiveDevice[]): number {
    let total = 0;
    const seen = new Set<string>();
    for (const device of devices) {
      seen.add(device.mac);
      const prev = this.previousCounters.get(device.mac);
      if (prev) {
        const dtMs = ts - prev.ts;
        const gapTooLarge = dtMs <= 0 || dtMs > 5 * 60_000;
        const sessionRestarted = Boolean(
          device.online_seconds !== null &&
          prev.online_seconds !== null &&
          device.online_seconds > 0 &&
          prev.online_seconds > 0 &&
          device.online_seconds < prev.online_seconds
        );

        let deltaKb = 0;
        if (!gapTooLarge) {
          if (device.down_sum_kb >= prev.down_sum_kb) {
            deltaKb = device.down_sum_kb - prev.down_sum_kb;
          } else if (sessionRestarted) {
            deltaKb = device.down_sum_kb;
          }
        }

        if (deltaKb > 0 && deltaKb <= 5 * 1024 * 1024) {
          total += Math.round((deltaKb * 1024 * 1000) / dtMs);
        }
      }
      this.previousCounters.set(device.mac, {
        ts,
        down_sum_kb: device.down_sum_kb,
        online_seconds: device.online_seconds,
      });
    }
    for (const mac of this.previousCounters.keys()) {
      if (!seen.has(mac)) this.previousCounters.delete(mac);
    }
    return total;
  }

  private get baseUrl(): string {
    return `http://${this.host}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/plain, */*; q=0.01',
      'Referer': `${this.baseUrl}/index.html?v=5042`,
    };
    if (this.cookie) headers.Cookie = this.cookie;
    return headers;
  }

  private async rawPost(url: string, body: unknown, timeoutMs = 2500): Promise<RawResp> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${url}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      return {
        status: resp.status,
        text: await resp.text(),
        setCookie: resp.headers.get('set-cookie'),
        redirected: resp.redirected,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private isExpired(resp: RawResp): boolean {
    if (resp.status === 401 || resp.redirected) return true;
    const text = resp.text.trimStart();
    return text.startsWith('<') || /login\.html/i.test(resp.text.slice(0, 5000));
  }

  private async login(): Promise<void> {
    if (this.inFlightLogin) return this.inFlightLogin;
    this.inFlightLogin = (async () => {
      const resp = await this.rawPost('/goform/module?auth&', {
        auth: {
          password: Buffer.from(this.password, 'utf-8').toString('base64'),
          time: timeString(),
        },
      }, 5000);
      const parsed = safeJson(resp.text);
      if (parsed?.auth !== 0) throw new Error(`router login failed: HTTP ${resp.status}`);
      const sid = resp.setCookie ? parseCookieValue(resp.setCookie, 'sessionid') : null;
      this.cookie = sid ? `bLanguage=en; sessionid=${sid}` : 'bLanguage=en';
    })();
    try {
      await this.inFlightLogin;
    } finally {
      this.inFlightLogin = null;
    }
  }

  private async call<T>(modules: string[], body: Record<string, unknown>): Promise<T> {
    if (!this.cookie) await this.login();
    const url = `/goform/module?${modules.join('&')}&`;
    let resp = await this.rawPost(url, body);
    if (this.isExpired(resp)) {
      this.cookie = null;
      await this.login();
      resp = await this.rawPost(url, body);
    }
    if (resp.status !== 200 || this.isExpired(resp)) {
      throw new Error(`router live API failed: HTTP ${resp.status}`);
    }
    const parsed = safeJson(resp.text);
    if (!parsed) throw new Error('router live API returned non-JSON');
    return parsed as T;
  }
}

function normalizeDevices(rows: Array<Record<string, unknown>> | undefined): RouterLiveDevice[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => Number(row.hostOnlineStatus ?? 0) === 1)
    .map((row) => ({
      mac: String(row.hostMAC ?? '').toUpperCase(),
      ip: stringOrNull(row.hostIP),
      hostname: stringOrNull(row.hostName),
      router_remark: stringOrNull(row.hostRemark),
      online: 1 as const,
      up_speed_bps: speedKbToBps(row.hostUploadSpeed),
      down_speed_bps: speedKbToBps(row.hostDownloadSpeed),
      down_sum_kb: Math.max(0, Math.round(Number(row.hostDownloadSum ?? 0))),
      connect_type: finiteNumber(row.hostConnectType),
      // Tenda firmware reports onlineTime in MINUTES. We store in seconds so
      // it lines up with samples_raw.online_seconds (= onlineMinutes * 60).
      online_seconds: finiteNumber(row.onlineTime) === null ? null : finiteNumber(row.onlineTime)! * 60,
    }))
    .filter((row) => row.mac.length > 0);
}

function speedKbToBps(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024) : 0;
}

function sumWanFlux(rows: Array<Record<string, unknown>> | undefined): { down: number; up: number } {
  let down = 0;
  let up = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = String(row.wanStatus ?? '').toLowerCase();
    if (status && status !== 'wired' && status !== 'connected') continue;
    down += parseFluxString(row.wanDownFlux);
    up += parseFluxString(row.wanUpFlux);
  }
  return { down, up };
}

function parseFluxString(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const match = value.trim().match(/^([\d.]+)\s*(B|KB|MB|GB)\/s$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'B' ? 1 : unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;
  return Math.round(n * multiplier);
}

function readRouterConfig(): { host: string; password: string } {
  const env = readRepoEnv();
  return {
    host: process.env.ROUTER_HOST || env.ROUTER_HOST || '192.168.0.1',
    password: process.env.ROUTER_PASSWORD || env.ROUTER_PASSWORD || '',
  };
}

function readRepoEnv(): Record<string, string> {
  const file = findUp(process.cwd(), '.env');
  if (!file) return {};
  try {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      out[match[1]] = parseEnvValue(match[2]);
    }
    return out;
  } catch {
    return {};
  }
}

function findUp(start: string, name: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timeString(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`;
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function parseCookieValue(setCookie: string, key: string): string | null {
  const segments = setCookie.split(/,(?=[^;]+=)/);
  for (const segment of segments) {
    const match = segment.match(new RegExp(`(?:^|; )${key}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}
