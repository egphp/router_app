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

export class RouterClient {
  private cookie: string | null = null;
  private inFlightLogin: Promise<void> | null = null;

  constructor(private readonly host: string, private readonly password: string) {}

  private get baseUrl(): string {
    return `http://${this.host}`;
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/plain, */*; q=0.01',
    };
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  private async rawPost(url: string, body: unknown, timeoutMs = 10000): Promise<{ status: number; text: string; setCookie: string | null }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${url}`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      return { status: resp.status, text, setCookie: resp.headers.get('set-cookie') };
    } finally {
      clearTimeout(t);
    }
  }

  async login(): Promise<void> {
    if (this.inFlightLogin) return this.inFlightLogin;
    this.inFlightLogin = (async () => {
      const password = encodePassword(this.password);
      const time = timeString();
      const url = '/goform/module?auth&';
      const body = { auth: { password, time } };
      const resp = await this.rawPost(url, body);
      const parsed = safeJson(resp.text);
      if (parsed?.auth !== 0) {
        throw new AuthError(`Login failed: status=${resp.status} body=${resp.text.slice(0, 200)}`);
      }
      if (resp.setCookie) {
        const sid = parseCookieValue(resp.setCookie, 'sessionid');
        if (sid) {
          this.cookie = `bLanguage=en; sessionid=${sid}`;
          log.info('router: logged in', { sessionid: sid });
        }
      } else if (!this.cookie) {
        this.cookie = 'bLanguage=en';
        log.warn('router: login response had no Set-Cookie; proceeding optimistically');
      }
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
    // 401 (or HTML login redirect) → re-auth and retry once
    if (resp.status === 401 || /login\.html/i.test(resp.text)) {
      log.warn('router: session expired, re-logging in');
      this.cookie = null;
      await this.login();
      resp = await this.rawPost(url, body);
    }
    if (resp.status !== 200) {
      throw new Error(`router POST ${url} HTTP ${resp.status}: ${resp.text.slice(0, 200)}`);
    }
    const parsed = safeJson(resp.text);
    if (!parsed) {
      throw new Error(`router POST ${url} non-JSON response: ${resp.text.slice(0, 200)}`);
    }
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
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function parseCookieValue(setCookie: string, key: string): string | null {
  // set-cookie may have multiple cookies comma-separated; pick the segment containing `key=`
  const segments = setCookie.split(/,(?=[^;]+=)/);
  for (const seg of segments) {
    const m = seg.match(new RegExp(`(?:^|; )${key}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}
