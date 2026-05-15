import type { RouterDevice, RouterSystemStatus } from '@tenda/shared';
import { log } from './logger.js';

function encodePassword(plain: string): string {
  return Buffer.from(plain, 'utf-8').toString('base64');
}

function timeString(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`;
}

export class AuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'AuthError'; }
}

interface RawResp {
  status: number;
  text: string;
  setCookie: string | null;
  location: string | null;
  contentType: string | null;
  redirected: boolean;
}

export class RouterClient {
  private cookie: string | null = null;
  private inFlightLogin: Promise<void> | null = null;
  private host: string;
  private password: string;
  private lastSuccessfulRequestTs = 0;

  constructor(host: string, password: string) {
    this.host = host;
    this.password = password;
  }

  /** Update credentials live (used by /api/settings). Forces re-login on next call. */
  setCredentials(host: string, password: string): void {
    this.host = host;
    this.password = password;
    this.cookie = null;
    log.info('router: credentials updated, forcing re-login on next call', { host });
  }

  getHost(): string { return this.host; }

  private get baseUrl(): string {
    return `http://${this.host}`;
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/plain, */*; q=0.01',
      'Referer': `${this.baseUrl}/index.html?v=5042`,
    };
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  private async rawPost(url: string, body: unknown, timeoutMs = 10000): Promise<RawResp> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${url}`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
        // Allow redirects so we always read a real body. We detect session-expiry from body shape.
        redirect: 'follow',
      });
      const text = await resp.text();
      return {
        status: resp.status,
        text,
        setCookie: resp.headers.get('set-cookie'),
        location: resp.headers.get('location'),
        contentType: resp.headers.get('content-type'),
        redirected: resp.redirected,
      };
    } finally {
      clearTimeout(t);
    }
  }

  private isSessionExpired(resp: RawResp): boolean {
    if (resp.status === 401) return true;
    if (resp.redirected) return true;
    // Tenda routes expired-session calls through /login.html; the body becomes HTML.
    const trimmed = resp.text.trimStart();
    if (trimmed.startsWith('<')) return true;
    if (resp.text.length > 0 && resp.text.length < 5000 && /login\.html/i.test(resp.text)) return true;
    return false;
  }

  async login(): Promise<void> {
    if (this.inFlightLogin) return this.inFlightLogin;
    this.inFlightLogin = (async () => {
      const password = encodePassword(this.password);
      const time = timeString();
      const url = '/goform/module?auth&';
      const body = { auth: { password, time } };
      const savedCookie = this.cookie;
      this.cookie = null;
      let resp: RawResp;
      try {
        resp = await this.rawPost(url, body);
      } catch (err) {
        this.cookie = savedCookie;
        throw err;
      }
      const parsed = safeJson(resp.text);
      if (parsed?.auth !== 0) {
        throw new AuthError(`Login failed: status=${resp.status} body=${resp.text.slice(0, 200)}`);
      }
      if (resp.setCookie) {
        const sid = parseCookieValue(resp.setCookie, 'sessionid');
        if (sid) {
          this.cookie = `bLanguage=en; sessionid=${sid}`;
          log.info('router: logged in', { sessionid: sid });
          this.lastSuccessfulRequestTs = Date.now();
          return;
        }
      }
      this.cookie = savedCookie ?? 'bLanguage=en';
      log.warn('router: login response had no Set-Cookie; reusing existing cookie');
    })();
    try {
      await this.inFlightLogin;
    } finally {
      this.inFlightLogin = null;
    }
  }

  async call<T = any>(modules: string[], body: Record<string, unknown>): Promise<T> {
    if (!this.cookie) await this.login();
    const url = `/goform/module?${modules.join('&')}&`;
    let resp = await this.rawPost(url, body);

    if (this.isSessionExpired(resp)) {
      log.warn('router: session expired, re-logging in', {
        status: resp.status,
        redirected: resp.redirected,
        bodyHead: resp.text.slice(0, 80).replace(/\s+/g, ' '),
      });
      this.cookie = null;
      await this.login();
      resp = await this.rawPost(url, body);
      if (this.isSessionExpired(resp)) {
        throw new AuthError(`re-auth did not restore session`);
      }
    }

    if (resp.status !== 200) {
      throw new Error(`router POST ${url} HTTP ${resp.status}: ${resp.text.slice(0, 200)}`);
    }
    const parsed = safeJson(resp.text);
    if (!parsed) {
      throw new Error(`router POST ${url} non-JSON response: ${resp.text.slice(0, 200)}`);
    }
    this.lastSuccessfulRequestTs = Date.now();
    return parsed as T;
  }

  async getSystemStatus(): Promise<RouterSystemStatus> {
    const r = await this.call<{ getSystemStatus: RouterSystemStatus }>(['getSystemStatus'], { getSystemStatus: '' });
    return r.getSystemStatus;
  }

  async getDeviceList(): Promise<RouterDevice[]> {
    const r = await this.call<{ getQosUserList: RouterDevice[] }>(
      ['getQosUserList', 'getQosPolicy'],
      { getQosUserList: { type: 1 }, getQosPolicy: '' },
    );
    return r.getQosUserList ?? [];
  }

  /** Lightweight call used as keepalive when sampler is idle. */
  async ping(): Promise<RouterSystemStatus> {
    return this.getSystemStatus();
  }

  /**
   * Get extended system info: CPU percent, memory percent, firmware version, model.
   * Field names vary by firmware; we return what we can parse.
   */
  async getSysInfo(): Promise<{
    cpuUsage?: number;
    memUsage?: number;
    firmware?: string;
    model?: string;
    raw: Record<string, unknown>;
  }> {
    try {
      const r = await this.call<{ getSysInfo: Record<string, unknown> }>(['getSysInfo'], { getSysInfo: '' });
      const x = r.getSysInfo ?? {};
      const num = (v: unknown): number | undefined => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
          const n = parseFloat(v.replace('%', ''));
          return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
      };
      return {
        cpuUsage: num((x as any).cpuUsed ?? (x as any).cpu ?? (x as any).cpuUsage),
        memUsage: num((x as any).memUsed ?? (x as any).mem ?? (x as any).memUsage ?? (x as any).memoryUsage),
        firmware: (x as any).softVer ?? (x as any).firmware ?? (x as any).fwVersion,
        model: (x as any).productName ?? (x as any).model,
        raw: x,
      };
    } catch (e) {
      log.warn('router.getSysInfo failed', String(e));
      return { raw: {} };
    }
  }

  /**
   * Per-WAN flow counters (dual-WAN routers expose 2 entries).
   * Returns an array; each entry has up/down byte counters and speeds when available.
   */
  async getWanFlow(): Promise<Array<Record<string, unknown>>> {
    try {
      const r = await this.call<{ getWanFlow: unknown }>(['getWanFlow'], { getWanFlow: '' });
      const flow = r.getWanFlow;
      if (Array.isArray(flow)) return flow;
      if (flow && typeof flow === 'object') return [flow as Record<string, unknown>];
      return [];
    } catch (e) {
      log.warn('router.getWanFlow failed', String(e));
      return [];
    }
  }

  /**
   * Reads the router's system log. sysLogType:
   *   0 = all, 1 = system events (login/sync), 2 = attack log (ARP/DDoS), 3 = quits
   */
  async getSystemLog(sysLogType = 0): Promise<Array<{ ID: number; sysLogTime: string; sysLogType: number; sysLogMsg: string }>> {
    try {
      const r = await this.call<{ getSystemLog: any }>(
        ['getSystemLog'],
        { getSystemLog: { sysLogType } },
      );
      const entries = r.getSystemLog;
      if (Array.isArray(entries)) return entries;
      return [];
    } catch (e) {
      log.warn('router.getSystemLog failed', String(e));
      return [];
    }
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function parseCookieValue(setCookie: string, key: string): string | null {
  const segments = setCookie.split(/,(?=[^;]+=)/);
  for (const seg of segments) {
    const m = seg.match(new RegExp(`(?:^|; )${key}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}
