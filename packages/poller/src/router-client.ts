import {
  isAic8800FallbackMac,
  type RouterDevice,
  type RouterPortMappingRule,
  type RouterSystemStatus,
  type RouterTrafficControlState,
} from '@tenda/shared';
import { log } from './logger.js';
import {
  MAX_ROUTER_DHCP_STATIC_BINDS,
  MAX_ROUTER_SPEED_LIMIT_KBS,
  buildSafeIpGroupName,
  ipv4ToInt,
  isValidLanIpv4,
  normalizeQosDevices,
  normalizeWanPorts,
  resolveIpWanBindings,
  sanitizeDhcpBindRemark,
  sanitizeRouterRemark,
  type RawRouterIpGroup,
  type RawRouterWanRule,
} from './traffic-control.js';
import {
  DEFAULT_SSH_INTERNAL_PORT,
  FALLBACK_SSH_WAN2_INTERNAL_PORT,
  WAN1_PROBE_ENDPOINTS,
  WAN2_PROBE_ENDPOINTS,
  isValidExternalSshPort,
} from './wan-public-ip.js';

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
  private mutationQueue: Promise<unknown> = Promise.resolve();
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
        cpuUsage: num((x as any).cpuUsePercent ?? (x as any).cpuUsed ?? (x as any).cpu ?? (x as any).cpuUsage),
        memUsage: num((x as any).memoryUsePercent ?? (x as any).memUsed ?? (x as any).mem ?? (x as any).memUsage ?? (x as any).memoryUsage),
        firmware: (x as any).sysInfoSoftVersion ?? (x as any).softVer ?? (x as any).firmware ?? (x as any).fwVersion,
        model: (x as any).sysInfoDevName ?? (x as any).productName ?? (x as any).model,
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
   * Per-WAN instantaneous flux reported as strings like "0.13KB/s", "12.4MB/s".
   * Returns parsed bytes/sec for each WAN port that is up.
   */
  async getWanFlux(): Promise<Array<{ id: number; upBps: number; downBps: number }>> {
    try {
      const r = await this.call<{ getWanInfo: Array<Record<string, unknown>> }>(['getWanInfo'], { getWanInfo: '' });
      const wans = Array.isArray(r.getWanInfo) ? r.getWanInfo : [];
      return wans
        .filter((w) => (w.wanStatus as string) === 'wired' || (w.wanStatus as string) === 'connected')
        .map((w) => ({
          id: Number(w.ID ?? 0),
          upBps: parseFluxString(w.wanUpFlux as string | undefined),
          downBps: parseFluxString(w.wanDownFlux as string | undefined),
        }));
    } catch (e) {
      log.warn('router.getWanFlux failed', String(e));
      return [];
    }
  }

  /**
   * Returns the router's Address Reservation list — merging persistent entries
   * from `getDhcpStaticBindList` (`enableStatus: true`) with active bound leases
   * in `getDhcpClientList` (`bindStatus: true`).
   */
  async getDhcpReservations(): Promise<Array<{ ID: number; bindStatus: boolean; bindIPAddr: string; bindMACAddr: string; hostName: string }>> {
    try {
      const r = await this.call<{
        getDhcpStaticBindList?: Array<Record<string, unknown>>;
        getDhcpClientList?: Array<Record<string, unknown>>;
      }>(
        ['getDhcpStaticBindList', 'getDhcpClientList'],
        { getDhcpStaticBindList: '', getDhcpClientList: '' },
      );

      const byMac = new Map<string, { ID: number; bindStatus: boolean; bindIPAddr: string; bindMACAddr: string; hostName: string }>();

      if (Array.isArray(r.getDhcpStaticBindList)) {
        for (const item of r.getDhcpStaticBindList) {
          if (!item || item.enableStatus === false) continue;
          const mac = String(item.bindMACAddr ?? '').trim().toUpperCase();
          const ip = String(item.bindIPAddr ?? '').trim();
          if (!mac || !ip) continue;
          byMac.set(mac, {
            ID: Number(item.ID ?? 0),
            bindStatus: true,
            bindIPAddr: ip,
            bindMACAddr: mac,
            hostName: String(item.bindRemark ?? '').trim(),
          });
        }
      }

      if (Array.isArray(r.getDhcpClientList)) {
        for (const item of r.getDhcpClientList) {
          if (!item || item.bindStatus !== true) continue;
          const mac = String(item.bindMACAddr ?? '').trim().toUpperCase();
          const ip = String(item.bindIPAddr ?? '').trim();
          if (!mac || !ip) continue;
          const existing = byMac.get(mac);
          if (!existing) {
            byMac.set(mac, {
              ID: Number(item.ID ?? 0),
              bindStatus: true,
              bindIPAddr: ip,
              bindMACAddr: mac,
              hostName: String(item.hostName ?? '').trim(),
            });
          } else if (!existing.hostName && item.hostName) {
            existing.hostName = String(item.hostName).trim();
          }
        }
      }

      return [...byMac.values()];
    } catch (e) {
      log.warn('router.getDhcpReservations failed', String(e));
      return [];
    }
  }

  /**
   * Create or update a persistent Static DHCP Address Reservation (`MAC -> IP`)
   * on the Tenda W30E using the `controlers/staticIP.js` `setDhcpStaticBindList` module.
   */
  async setDeviceDhcpReservation(opts: {
    mac: string;
    ip: string;
    remark?: string | null;
    allowUpdateIp?: boolean;
  }): Promise<{
    ok: boolean;
    alreadyReserved?: boolean;
    code?: string;
    error?: string;
    applied?: { mac: string; ip: string; remark: string; routerId: number };
  }> {
    return this.enqueueMutation(async () => {
      const mac = opts.mac.trim().toUpperCase();
      if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac)) {
        return { ok: false, code: 'INVALID_MAC', error: 'Invalid MAC address' };
      }
      if (isAic8800FallbackMac(mac)) {
        return { ok: false, code: 'AIC8800_FALLBACK_MAC', error: 'Refusing to reserve ephemeral AIC8800 boot-fallback MAC.' };
      }
      const ip = opts.ip.trim();
      if (!isValidLanIpv4(ip)) {
        return { ok: false, code: 'INVALID_LAN_IP', error: 'A valid private LAN IPv4 address is required for DHCP reservation.' };
      }

      const current = await this.call<{
        getDhcpStaticBindList?: Array<Record<string, unknown>>;
        getLanIpMask?: { lanIP?: string; lanMask?: string };
      }>(
        ['getDhcpStaticBindList', 'getLanIpMask'],
        { getDhcpStaticBindList: '', getLanIpMask: '' },
      );

      const lanIp = String(current.getLanIpMask?.lanIP ?? '').trim();
      const lanMask = String(current.getLanIpMask?.lanMask ?? '').trim();
      const ipInt = ipv4ToInt(ip)!;
      const lanInt = ipv4ToInt(lanIp);
      const maskInt = ipv4ToInt(lanMask);
      if (lanInt !== null && maskInt !== null) {
        if (ipInt === lanInt) {
          return { ok: false, code: 'INVALID_LAN_IP', error: 'Cannot reserve the router LAN gateway IP.' };
        }
        if (((ipInt & maskInt) >>> 0) !== ((lanInt & maskInt) >>> 0)) {
          return { ok: false, code: 'SUBNET_MISMATCH', error: `IP ${ip} is outside the router LAN subnet (${lanIp}/${lanMask}).` };
        }
        const hostMask = (~maskInt) >>> 0;
        const hostPart = (ipInt & hostMask) >>> 0;
        if (hostPart === 0 || hostPart === hostMask) {
          return { ok: false, code: 'INVALID_LAN_IP', error: 'Network and broadcast addresses cannot be reserved.' };
        }
      }

      const bindRemark = sanitizeDhcpBindRemark(opts.remark);
      const list = Array.isArray(current.getDhcpStaticBindList) ? current.getDhcpStaticBindList : [];
      const existingByMac = list.find((x) => String(x.bindMACAddr ?? '').trim().toUpperCase() === mac);

      if (existingByMac && existingByMac.enableStatus !== false) {
        const existingIp = String(existingByMac.bindIPAddr ?? '').trim();
        const existingRemark = String(existingByMac.bindRemark ?? '').trim();
        if (existingIp === ip || !opts.allowUpdateIp) {
          return {
            ok: true,
            alreadyReserved: true,
            applied: {
              mac,
              ip: existingIp || ip,
              remark: existingRemark || bindRemark,
              routerId: Number(existingByMac.ID ?? 0),
            },
          };
        }
      }

      const ipConflict = list.find(
        (x) =>
          x.enableStatus !== false &&
          String(x.bindIPAddr ?? '').trim() === ip &&
          String(x.bindMACAddr ?? '').trim().toUpperCase() !== mac,
      );
      if (ipConflict) {
        return {
          ok: false,
          code: 'IP_ALREADY_RESERVED',
          error: `IP ${ip} is already reserved on the router for MAC ${String(ipConflict.bindMACAddr).toUpperCase()}.`,
        };
      }

      if (existingByMac) {
        const routerId = Number(existingByMac.ID ?? 0);
        const nextRemark = bindRemark || sanitizeDhcpBindRemark(String(existingByMac.bindRemark ?? ''));
        await this.call(['setDhcpStaticBindList'], {
          setDhcpStaticBindList: {
            type: 'edit',
            data: {
              ID: routerId,
              bindIPAddr: ip,
              bindMACAddr: mac,
              bindRemark: nextRemark,
            },
          },
        });
        if (existingByMac.enableStatus === false) {
          await this.call(['setDhcpStaticBindList'], {
            setDhcpStaticBindList: {
              type: 'switch',
              data: { ID: routerId, enableStatus: true },
            },
          });
        }
        log.info('router: updated static DHCP reservation', { mac, ip, routerId });
        return {
          ok: true,
          alreadyReserved: false,
          applied: { mac, ip, remark: nextRemark, routerId },
        };
      }

      if (list.length >= MAX_ROUTER_DHCP_STATIC_BINDS) {
        return {
          ok: false,
          code: 'MAX_RESERVATIONS_REACHED',
          error: `Router static DHCP reservation limit (${MAX_ROUTER_DHCP_STATIC_BINDS}) reached.`,
        };
      }

      const addResp = await this.call<{ setDhcpStaticBindList?: number }>(['setDhcpStaticBindList'], {
        setDhcpStaticBindList: {
          type: 'add',
          data: [{
            bindIPAddr: ip,
            bindMACAddr: mac,
            bindRemark,
          }],
        },
      });
      if (addResp.setDhcpStaticBindList !== undefined && Number(addResp.setDhcpStaticBindList) !== 0) {
        return {
          ok: false,
          code: 'ROUTER_REJECTED_RESERVATION',
          error: `Router rejected DHCP reservation (code ${addResp.setDhcpStaticBindList}).`,
        };
      }

      const after = await this.call<{ getDhcpStaticBindList?: Array<Record<string, unknown>> }>(
        ['getDhcpStaticBindList'],
        { getDhcpStaticBindList: '' },
      );
      const created = (after.getDhcpStaticBindList ?? []).find(
        (x) => String(x.bindMACAddr ?? '').trim().toUpperCase() === mac,
      );
      const routerId = Number(created?.ID ?? 0);
      log.info('router: added static DHCP reservation', { mac, ip, routerId, remark: bindRemark });
      return {
        ok: true,
        alreadyReserved: false,
        applied: { mac, ip, remark: bindRemark, routerId },
      };
    });
  }

  /**
   * Remove a persistent Static DHCP Address Reservation (`MAC`) from `getDhcpStaticBindList`.
   */
  async removeDeviceDhcpReservation(opts: {
    mac: string;
  }): Promise<{
    ok: boolean;
    removed?: boolean;
    code?: string;
    error?: string;
  }> {
    return this.enqueueMutation(async () => {
      const mac = opts.mac.trim().toUpperCase();
      if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac)) {
        return { ok: false, code: 'INVALID_MAC', error: 'Invalid MAC address' };
      }

      const current = await this.call<{ getDhcpStaticBindList?: Array<Record<string, unknown>> }>(
        ['getDhcpStaticBindList'],
        { getDhcpStaticBindList: '' },
      );
      const matches = (current.getDhcpStaticBindList ?? []).filter(
        (x) => String(x.bindMACAddr ?? '').trim().toUpperCase() === mac,
      );
      if (matches.length === 0) {
        return { ok: true, removed: false };
      }

      const ids = matches.map((x) => Number(x.ID)).filter((id) => Number.isFinite(id) && id > 0);
      if (ids.length > 0) {
        await this.call(['setDhcpStaticBindList'], {
          setDhcpStaticBindList: { type: 'delete', data: ids },
        });
      }
      log.info('router: removed static DHCP reservation', { mac, ids });
      return { ok: true, removed: true };
    });
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

  private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Read full QoS bandwidth + Multi-WAN routing policy state from the Tenda W30E.
   */
  async getTrafficControlState(): Promise<RouterTrafficControlState> {
    const [qosResp, wanResp] = await Promise.all([
      this.call<{
        getQosPolicy?: { qosPolicy?: number };
        getWanAutoSpeed?: Array<{ ID: number; wanUpstream: number; wanDownstream: number }>;
        getQosUserList?: RouterDevice[];
      }>(
        ['getQosPolicy', 'getWanAutoSpeed', 'getQosUserList'],
        { getQosPolicy: '', getWanAutoSpeed: '', getQosUserList: { type: 1 } },
      ),
      this.call<{
        getWanInfo?: Array<Record<string, unknown>>;
        getWanRoutePolicy?: { wanRoutePolicyType?: string };
        getWanRouteRules?: RawRouterWanRule[];
        getIPGroupList?: RawRouterIpGroup[];
      }>(
        ['getWanInfo', 'getWanRoutePolicy', 'getWanRouteRules', 'getIPGroupList'],
        { getWanInfo: '', getWanRoutePolicy: '', getWanRouteRules: '', getIPGroupList: '' },
      ),
    ]);

    const qosDevices = normalizeQosDevices(qosResp.getQosUserList ?? []);
    const wanPorts = normalizeWanPorts(wanResp.getWanInfo, parseFluxString);
    const ipGroups = Array.isArray(wanResp.getIPGroupList) ? wanResp.getIPGroupList : [];
    const wanRules = Array.isArray(wanResp.getWanRouteRules) ? wanResp.getWanRouteRules : [];
    const bindingsMap = resolveIpWanBindings(ipGroups, wanRules);

    return {
      qosPolicy: Number(qosResp.getQosPolicy?.qosPolicy ?? 1),
      wanRoutePolicyType: String(wanResp.getWanRoutePolicy?.wanRoutePolicyType ?? 'auto'),
      wanPorts,
      qosDevices,
      wanBindings: [...bindingsMap.values()],
    };
  }

  /**
   * Update per-device Download / Upload bandwidth limit (in integer KB/s; `0` = unlimited)
   * on the Tenda W30E using the exact `qosManage.js` firmware contract:
   * - `actionFlag: 5` when `hostOnlineStatus === 1`
   * - `actionFlag: 6` when `hostOnlineStatus === 0`
   * - Always preserves `ID` and `hostRemark` unless `remark` is explicitly provided.
   */
  async setDeviceSpeedLimit(opts: {
    mac: string;
    downloadLimitKBs: number;
    uploadLimitKBs: number;
    remark?: string;
  }): Promise<{
    ok: boolean;
    code?: string;
    error?: string;
    applied?: { mac: string; routerId: number; downloadLimitKBs: number; uploadLimitKBs: number; remark: string };
  }> {
    return this.enqueueMutation(async () => {
      const mac = opts.mac.trim().toUpperCase();
      if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac)) {
        return { ok: false, code: 'INVALID_MAC', error: 'Invalid MAC address' };
      }
      const dl = Math.round(Number(opts.downloadLimitKBs));
      const ul = Math.round(Number(opts.uploadLimitKBs));
      if (
        !Number.isFinite(dl) || dl < 0 || dl > MAX_ROUTER_SPEED_LIMIT_KBS ||
        !Number.isFinite(ul) || ul < 0 || ul > MAX_ROUTER_SPEED_LIMIT_KBS
      ) {
        return { ok: false, code: 'INVALID_SPEED_LIMIT', error: `Speed limit must be 0..${MAX_ROUTER_SPEED_LIMIT_KBS} KB/s` };
      }

      const current = await this.call<{
        getQosPolicy?: { qosPolicy?: number };
        getWanAutoSpeed?: Array<{ ID: number; wanUpstream: number; wanDownstream: number }>;
        getQosUserList?: Array<Record<string, unknown>>;
      }>(
        ['getQosPolicy', 'getWanAutoSpeed', 'getQosUserList'],
        { getQosPolicy: '', getWanAutoSpeed: '', getQosUserList: { type: 1 } },
      );

      const list = Array.isArray(current.getQosUserList) ? current.getQosUserList : [];
      const target = list.find((u) => String(u.hostMAC ?? '').trim().toUpperCase() === mac);
      if (!target) {
        return {
          ok: false,
          code: 'NOT_IN_ROUTER_QOS_TABLE',
          error: 'Device is not currently listed in the router QoS table (connect the device first so the router assigns a host ID).',
        };
      }

      const routerId = Number(target.ID);
      const isOnline = Number(target.hostOnlineStatus ?? 0) === 1;
      const actionFlag = isOnline ? 5 : 6;
      const hostRemark = opts.remark !== undefined
        ? sanitizeRouterRemark(opts.remark)
        : sanitizeRouterRemark(String(target.hostRemark ?? ''));

      const wanAutoSpeed = Array.isArray(current.getWanAutoSpeed) && current.getWanAutoSpeed.length > 0
        ? current.getWanAutoSpeed
        : [
            { ID: 1, wanUpstream: 300, wanDownstream: 300 },
            { ID: 2, wanUpstream: 300, wanDownstream: 300 },
          ];

      await this.call(
        ['setQosPolicy', 'setWanAutoSpeed', 'setQosUserList'],
        {
          setQosPolicy: { qosPolicy: 2 },
          setWanAutoSpeed: wanAutoSpeed,
          setQosUserList: {
            type: 'edit',
            actionFlag,
            data: [{
              ID: routerId,
              hostRemark,
              hostUploadLimit: ul,
              hostDownloadLimit: dl,
            }],
          },
        },
      );

      log.info('router: updated device QoS speed limit', { mac, routerId, actionFlag, dl, ul });
      return {
        ok: true,
        applied: { mac, routerId, downloadLimitKBs: dl, uploadLimitKBs: ul, remark: hostRemark },
      };
    });
  }

  /**
   * Bind or unbind a single LAN IPv4 address to a specific WAN port (`'WAN1'`, `'WAN2'`, or `'auto'`)
   * using the 2-stage Tenda W30E `ipTimeGroup.js` (Stage 1: IP Group) + `multiWan.js` (Stage 2: Multi-WAN Rule) protocol.
   */
  async setDeviceWanBinding(opts: {
    ip: string;
    labelHint?: string | null;
    groupName?: string | null;
    wanPort: string;
  }): Promise<{
    ok: boolean;
    code?: string;
    error?: string;
    applied?: { ip: string; wanPort: string; ipGroupName: string | null };
  }> {
    return this.enqueueMutation(async () => {
      const ip = opts.ip.trim();
      if (!isValidLanIpv4(ip)) {
        return { ok: false, code: 'INVALID_LAN_IP', error: 'A valid private LAN IPv4 address is required for WAN routing.' };
      }

      const rawWan = opts.wanPort.trim();
      const targetWan = rawWan.toLowerCase() === 'auto' ? 'auto' : rawWan.toUpperCase();

      const current = await this.call<{
        getWanInfo?: Array<Record<string, unknown>>;
        getWanRoutePolicy?: { wanRoutePolicyType?: string };
        getWanRouteRules?: RawRouterWanRule[];
        getIPGroupList?: RawRouterIpGroup[];
      }>(
        ['getWanInfo', 'getWanRoutePolicy', 'getWanRouteRules', 'getIPGroupList'],
        { getWanInfo: '', getWanRoutePolicy: '', getWanRouteRules: '', getIPGroupList: '' },
      );

      const wanPorts = normalizeWanPorts(current.getWanInfo, parseFluxString);
      const validWanNames = new Set(wanPorts.length > 0 ? wanPorts.map((p) => p.wanName) : ['WAN1', 'WAN2']);
      if (targetWan !== 'auto' && !validWanNames.has(targetWan)) {
        return { ok: false, code: 'INVALID_WAN_PORT', error: `Unsupported WAN port: ${opts.wanPort}` };
      }

      const ipGroups = Array.isArray(current.getIPGroupList) ? current.getIPGroupList : [];
      const wanRules = Array.isArray(current.getWanRouteRules) ? current.getWanRouteRules : [];
      const ipInt = ipv4ToInt(ip)!;

      // Check for single-IP group vs intersecting range group.
      const singleIpGroup = ipGroups.find((g) => g.IPGroupStartIP === ip && g.IPGroupEndIP === ip && !g.IPGroupDefaultTag);
      const intersectingRangeGroup = ipGroups.find((g) => {
        if (g.IPGroupDefaultTag || g.IPGroupName === ':full:' || g.IPGroupName === ':all:wifi:guest:') return false;
        if (g.IPGroupStartIP === ip && g.IPGroupEndIP === ip) return false;
        const s = ipv4ToInt(g.IPGroupStartIP);
        const e = ipv4ToInt(g.IPGroupEndIP);
        return s !== null && e !== null && ipInt >= s && ipInt <= e;
      });

      if (!singleIpGroup && intersectingRangeGroup) {
        return {
          ok: false,
          code: 'SHARED_IP_RANGE_RULE',
          error: `IP ${ip} belongs to shared router IP range group "${intersectingRangeGroup.IPGroupName}" (${intersectingRangeGroup.IPGroupStartIP}~${intersectingRangeGroup.IPGroupEndIP}). Edit that range group directly on the router if you wish to split it.`,
        };
      }

      const existingRule = singleIpGroup
        ? wanRules.find((r) => r.IPGroupName === singleIpGroup.IPGroupName)
        : undefined;

      if (targetWan === 'auto') {
        if (existingRule) {
          await this.call(['setWanRouteRules'], {
            setWanRouteRules: { type: 'delete', data: [Number(existingRule.ID)] },
          });
        }
        // Re-fetch IP groups so `IPGroupRefer` reflects the deleted rule; remove orphan single-IP group if unused.
        const refreshedGroupsResp = await this.call<{ getIPGroupList?: RawRouterIpGroup[] }>(
          ['getIPGroupList'],
          { getIPGroupList: '' },
        );
        const refreshedGroup = (refreshedGroupsResp.getIPGroupList ?? []).find(
          (g) => g.IPGroupStartIP === ip && g.IPGroupEndIP === ip && !g.IPGroupDefaultTag,
        );
        if (refreshedGroup && Number(refreshedGroup.IPGroupRefer ?? 0) === 0) {
          await this.call(['setIPGroupList'], {
            setIPGroupList: { type: 'delete', data: [Number(refreshedGroup.ID)] },
          });
        }
        log.info('router: cleared single-WAN binding -> auto load balance', { ip });
        return { ok: true, applied: { ip, wanPort: 'auto', ipGroupName: null } };
      }

      // Stage 2 prerequisite: ensure router Multi-WAN policy mode is 'custom' so per-IP WAN rules are active.
      if (String(current.getWanRoutePolicy?.wanRoutePolicyType ?? '') !== 'custom') {
        await this.call(['setWanRoutePolicy'], {
          setWanRoutePolicy: { wanRoutePolicyType: 'custom' },
        });
      }

      const explicitGroupRequested = typeof opts.groupName === 'string' && opts.groupName.trim().length > 0;
      const otherGroupNames = new Set(
        ipGroups
          .filter((g) => !singleIpGroup || Number(g.ID) !== Number(singleIpGroup.ID))
          .map((g) => g.IPGroupName),
      );
      const desiredGroupName = explicitGroupRequested
        ? buildSafeIpGroupName(opts.groupName, ip, otherGroupNames)
        : (singleIpGroup?.IPGroupName ?? buildSafeIpGroupName(opts.labelHint, ip, otherGroupNames));

      // Case A: Single-IP group already exists with the desired name.
      if (singleIpGroup && singleIpGroup.IPGroupName === desiredGroupName) {
        if (existingRule) {
          await this.call(['setWanRouteRules'], {
            setWanRouteRules: {
              type: 'edit',
              data: {
                ID: Number(existingRule.ID),
                wanRouteRuleEn: true,
                IPGroupName: desiredGroupName,
                wanRouteRuleWAN: targetWan,
              },
            },
          });
          log.info('router: updated single-WAN binding', { ip, group: desiredGroupName, wanPort: targetWan });
          return { ok: true, applied: { ip, wanPort: targetWan, ipGroupName: desiredGroupName } };
        }

        await this.call(['setWanRouteRules'], {
          setWanRouteRules: {
            type: 'add',
            data: {
              wanRouteRuleEn: true,
              IPGroupName: desiredGroupName,
              wanRouteRuleWAN: targetWan,
            },
          },
        });
        log.info('router: added single-WAN rule for existing IP group', { ip, group: desiredGroupName, wanPort: targetWan });
        return { ok: true, applied: { ip, wanPort: targetWan, ipGroupName: desiredGroupName } };
      }

      // Case B: Single-IP group exists, and owner requested renaming its IP Group!
      if (singleIpGroup && singleIpGroup.IPGroupName !== desiredGroupName) {
        if (existingRule) {
          await this.call(['setWanRouteRules'], {
            setWanRouteRules: { type: 'delete', data: [Number(existingRule.ID)] },
          });
        }
        const refreshedResp = await this.call<{ getIPGroupList?: RawRouterIpGroup[] }>(
          ['getIPGroupList'],
          { getIPGroupList: '' },
        );
        const refreshedGroup = (refreshedResp.getIPGroupList ?? []).find(
          (g) => Number(g.ID) === Number(singleIpGroup.ID),
        );
        if (refreshedGroup && Number(refreshedGroup.IPGroupRefer ?? 0) === 0) {
          await this.call(['setIPGroupList'], {
            setIPGroupList: {
              type: 'edit',
              data: {
                ID: Number(singleIpGroup.ID),
                IPGroupName: desiredGroupName,
                IPGroupStartIP: ip,
                IPGroupEndIP: ip,
              },
            },
          });
        } else {
          await this.call(['setIPGroupList'], {
            setIPGroupList: {
              type: 'add',
              data: {
                IPGroupName: desiredGroupName,
                IPGroupStartIP: ip,
                IPGroupEndIP: ip,
              },
            },
          });
        }

        await this.call(['setWanRouteRules'], {
          setWanRouteRules: {
            type: 'add',
            data: {
              wanRouteRuleEn: true,
              IPGroupName: desiredGroupName,
              wanRouteRuleWAN: targetWan,
            },
          },
        });
        log.info('router: renamed IP group and updated single-WAN binding', { ip, group: desiredGroupName, wanPort: targetWan });
        return { ok: true, applied: { ip, wanPort: targetWan, ipGroupName: desiredGroupName } };
      }

      // Case C: Stage 1 create IP Group -> Stage 2 create Multi-WAN Rule.
      await this.call(['setIPGroupList'], {
        setIPGroupList: {
          type: 'add',
          data: {
            IPGroupName: desiredGroupName,
            IPGroupStartIP: ip,
            IPGroupEndIP: ip,
          },
        },
      });

      await this.call(['setWanRouteRules'], {
        setWanRouteRules: {
          type: 'add',
          data: {
            wanRouteRuleEn: true,
            IPGroupName: desiredGroupName,
            wanRouteRuleWAN: targetWan,
          },
        },
      });

      log.info('router: added single-WAN binding', { ip, group: desiredGroupName, wanPort: targetWan });
      return { ok: true, applied: { ip, wanPort: targetWan, ipGroupName: desiredGroupName } };
    });
  }

  /**
   * Ensure `/32` host static routes exist on the Tenda W30E so dedicated public-IP
   * echo endpoints always egress via `WAN1` and `WAN2` independently.
   * Idempotent: makes zero `setStaticRoute` calls when routes already match.
   */
  async ensureWanProbeStaticRoutes(): Promise<{ ok: boolean; updatedCount: number }> {
    return this.enqueueMutation(async () => {
      const resp = await this.call<{
        getWanInfo?: Array<Record<string, unknown>>;
        getStaticRoute?: Array<Record<string, unknown>>;
      }>(
        ['getWanInfo', 'getStaticRoute'],
        { getWanInfo: '', getStaticRoute: '' },
      );

      const wanPorts = normalizeWanPorts(resp.getWanInfo, parseFluxString);
      const staticRoutes = Array.isArray(resp.getStaticRoute) ? resp.getStaticRoute : [];
      let updatedCount = 0;

      const desired: Array<{ ip: string; gateway: string; wanName: string }> = [];
      for (const p of wanPorts) {
        const connected = p.status === 'wired' || p.status === 'connected';
        if (!connected || !p.wanGateway || ipv4ToInt(p.wanGateway) === null) continue;
        if (p.wanId === 1) {
          desired.push(
            { ip: WAN1_PROBE_ENDPOINTS.httpsIp, gateway: p.wanGateway, wanName: 'WAN1' },
            { ip: WAN1_PROBE_ENDPOINTS.dnsIp, gateway: p.wanGateway, wanName: 'WAN1' },
          );
        } else if (p.wanId === 2) {
          desired.push(
            { ip: WAN2_PROBE_ENDPOINTS.httpsIp, gateway: p.wanGateway, wanName: 'WAN2' },
            { ip: WAN2_PROBE_ENDPOINTS.dnsIp, gateway: p.wanGateway, wanName: 'WAN2' },
          );
        }
      }

      for (const item of desired) {
        const existing = staticRoutes.find(
          (r) =>
            String(r.staticRouteNet ?? '').trim() === item.ip &&
            String(r.staticRouteMask ?? '').trim() === '255.255.255.255',
        );
        if (!existing) {
          await this.call(['setStaticRoute'], {
            setStaticRoute: {
              type: 'add',
              data: {
                staticRouteNet: item.ip,
                staticRouteMask: '255.255.255.255',
                staticRouteGateway: item.gateway,
                staticRouteWAN: item.wanName,
              },
            },
          });
          updatedCount++;
        } else if (
          String(existing.staticRouteGateway ?? '').trim() !== item.gateway ||
          String(existing.staticRouteWAN ?? '').trim().toUpperCase() !== item.wanName
        ) {
          await this.call(['setStaticRoute'], {
            setStaticRoute: {
              type: 'edit',
              data: {
                ID: Number(existing.ID),
                staticRouteNet: item.ip,
                staticRouteMask: '255.255.255.255',
                staticRouteGateway: item.gateway,
                staticRouteWAN: item.wanName,
              },
            },
          });
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        log.info('router: synced /32 WAN public-IP probe static routes', { updatedCount });
      }
      return { ok: true, updatedCount };
    });
  }

  /**
   * Read Tenda W30E TCP/UDP port mapping rules (`controlers/portMapping.js`).
   * Note firmware field typo `porMappingtInternal` and 0-based `portMappingWan` (`0` = WAN1, `1` = WAN2).
   */
  async getPortMappings(): Promise<RouterPortMappingRule[]> {
    try {
      const r = await this.call<{ getPortMapping?: Array<Record<string, unknown>> }>(
        ['getPortMapping'],
        { getPortMapping: '' },
      );
      const list = Array.isArray(r.getPortMapping) ? r.getPortMapping : [];
      return list
        .map((pm) => ({
          id: Number(pm.ID ?? 0),
          wanId: Number(pm.portMappingWan ?? 0) + 1,
          serverIp: String(pm.portMappingServer ?? '').trim(),
          internalPort: Number(pm.porMappingtInternal ?? pm.portMappingInternal ?? 0),
          externalPort: Number(pm.portMappingExternal ?? 0),
          protocol: Number(pm.portMappingProtocol ?? 0),
          enabled: Boolean(pm.portMappingEn),
        }))
        .filter((pm) => pm.id > 0 && pm.serverIp.length > 0);
    } catch (e) {
      log.warn('router.getPortMappings failed', String(e));
      return [];
    }
  }

  /**
   * Configure SSH-only TCP Port Mapping on both `WAN1` (`portMappingWan: 0`) and `WAN2` (`portMappingWan: 1`)
   * while strictly disabling Tenda `DMZ` (`dmzEn: false`) so no non-SSH ports on the Mac are exposed.
   * Automatically falls back to `fallbackInternalPortWan2` (`2222`) on `WAN2` if the router rejects
   * duplicate internal port `22` across two rules for the same LAN IP.
   */
  async configureSshPortMapping(opts: {
    enabled: boolean;
    targetIp: string;
    externalPort: number;
    internalPortWan1?: number;
    fallbackInternalPortWan2?: number;
  }): Promise<{
    ok: boolean;
    code?: string;
    error?: string;
    dmzDisabled: boolean;
    wan1Rule: RouterPortMappingRule | null;
    wan2Rule: RouterPortMappingRule | null;
    usedFallbackPortWan2: boolean;
  }> {
    return this.enqueueMutation(async () => {
      const ip = opts.targetIp.trim();
      if (!isValidLanIpv4(ip)) {
        return {
          ok: false,
          code: 'INVALID_LAN_IP',
          error: 'A valid private LAN IPv4 address is required for SSH port forwarding.',
          dmzDisabled: false,
          wan1Rule: null,
          wan2Rule: null,
          usedFallbackPortWan2: false,
        };
      }
      const extPort = Number(opts.externalPort);
      if (!isValidExternalSshPort(extPort)) {
        return {
          ok: false,
          code: 'INVALID_SSH_PORT',
          error: 'External SSH port must be 22 or between 1024 and 65535.',
          dmzDisabled: false,
          wan1Rule: null,
          wan2Rule: null,
          usedFallbackPortWan2: false,
        };
      }

      const intWan1 = opts.internalPortWan1 ?? DEFAULT_SSH_INTERNAL_PORT;
      const fallbackWan2 = opts.fallbackInternalPortWan2 ?? FALLBACK_SSH_WAN2_INTERNAL_PORT;
      const sshInternalPorts = new Set([intWan1, fallbackWan2]);

      const initial = await this.call<{
        getDMZ?: Array<Record<string, unknown>>;
        getPortMapping?: Array<Record<string, unknown>>;
      }>(
        ['getDMZ', 'getPortMapping'],
        { getDMZ: '', getPortMapping: '' },
      );

      // Security invariant: never leave Tenda DMZ enabled (DMZ exposes all 65,535 ports on the Mac).
      let dmzDisabled = true;
      const dmzList = Array.isArray(initial.getDMZ) ? initial.getDMZ : [];
      if (dmzList.some((d) => d.dmzEn === true)) {
        const disabledDmz = dmzList.map((d) => ({
          ...d,
          dmzEn: false,
        }));
        const dmzResp = await this.call<{ setDMZ?: number }>(['setDMZ'], {
          setDMZ: { type: 'edit', data: disabledDmz },
        });
        dmzDisabled = dmzResp.setDMZ === undefined || Number(dmzResp.setDMZ) === 0;
        log.info('router: ensured Tenda DMZ is OFF so only SSH port mapping is exposed', { dmzDisabled });
      }

      const rawList = Array.isArray(initial.getPortMapping) ? initial.getPortMapping : [];

      if (!opts.enabled) {
        for (const pm of rawList) {
          const pmIp = String(pm.portMappingServer ?? '').trim();
          const pmInt = Number(pm.porMappingtInternal ?? pm.portMappingInternal ?? 0);
          if (pmIp === ip && sshInternalPorts.has(pmInt) && pm.portMappingEn === true) {
            await this.call(['setPortMapping'], {
              setPortMapping: {
                type: 'switch',
                data: { ID: Number(pm.ID), portMappingEn: false },
              },
            });
          }
        }
        log.info('router: disabled external SSH port mappings', { targetIp: ip });
        return {
          ok: true,
          dmzDisabled,
          wan1Rule: null,
          wan2Rule: null,
          usedFallbackPortWan2: false,
        };
      }

      const upsertWanRule = async (
        wanZeroIdx: 0 | 1,
        internalPort: number,
        snapshot: Array<Record<string, unknown>>,
      ): Promise<boolean> => {
        const existing = snapshot.find((pm) => {
          const pmWan = Number(pm.portMappingWan ?? -1);
          const pmIp = String(pm.portMappingServer ?? '').trim();
          const pmInt = Number(pm.porMappingtInternal ?? pm.portMappingInternal ?? 0);
          const pmExt = Number(pm.portMappingExternal ?? 0);
          return pmWan === wanZeroIdx && pmIp === ip && (sshInternalPorts.has(pmInt) || pmExt === extPort);
        });

        if (existing) {
          const id = Number(existing.ID);
          const curInt = Number(existing.porMappingtInternal ?? existing.portMappingInternal ?? 0);
          const curExt = Number(existing.portMappingExternal ?? 0);
          const curProto = Number(existing.portMappingProtocol ?? -1);
          if (curInt !== internalPort || curExt !== extPort || curProto !== 1) {
            const editResp = await this.call<{ setPortMapping?: number }>(['setPortMapping'], {
              setPortMapping: {
                type: 'edit',
                data: {
                  ID: id,
                  portMappingServer: ip,
                  porMappingtInternal: String(internalPort),
                  portMappingExternal: String(extPort),
                  portMappingProtocol: 1,
                  portMappingWan: wanZeroIdx,
                },
              },
            });
            if (editResp.setPortMapping !== undefined && Number(editResp.setPortMapping) !== 0) {
              return false;
            }
          }
          if (existing.portMappingEn !== true) {
            const swResp = await this.call<{ setPortMapping?: number }>(['setPortMapping'], {
              setPortMapping: {
                type: 'switch',
                data: { ID: id, portMappingEn: true },
              },
            });
            if (swResp.setPortMapping !== undefined && Number(swResp.setPortMapping) !== 0) {
              return false;
            }
          }
          return true;
        }

        const addResp = await this.call<{ setPortMapping?: number }>(['setPortMapping'], {
          setPortMapping: {
            type: 'add',
            data: {
              portMappingServer: ip,
              porMappingtInternal: String(internalPort),
              portMappingExternal: String(extPort),
              portMappingProtocol: 1,
              portMappingWan: wanZeroIdx,
            },
          },
        });
        return addResp.setPortMapping === undefined || Number(addResp.setPortMapping) === 0;
      };

      const wan1Ok = await upsertWanRule(0, intWan1, rawList);
      if (!wan1Ok) {
        return {
          ok: false,
          code: 'ROUTER_REJECTED_WAN1_PORT_MAP',
          error: `Router rejected SSH port mapping on WAN1 (${extPort} -> ${ip}:${intWan1}).`,
          dmzDisabled,
          wan1Rule: null,
          wan2Rule: null,
          usedFallbackPortWan2: false,
        };
      }

      const afterWan1 = await this.call<{ getPortMapping?: Array<Record<string, unknown>> }>(
        ['getPortMapping'],
        { getPortMapping: '' },
      );
      const listAfterWan1 = Array.isArray(afterWan1.getPortMapping) ? afterWan1.getPortMapping : [];

      let usedFallbackPortWan2 = false;
      const wan2DirectOk = await upsertWanRule(1, intWan1, listAfterWan1);
      let finalMappings = await this.getPortMappings();
      let wan2Rule =
        finalMappings.find(
          (m) =>
            m.wanId === 2 &&
            m.serverIp === ip &&
            m.externalPort === extPort &&
            m.internalPort === intWan1 &&
            m.protocol === 1 &&
            m.enabled,
        ) ?? null;

      if (!wan2DirectOk || !wan2Rule) {
        const afterAttempt = await this.call<{ getPortMapping?: Array<Record<string, unknown>> }>(
          ['getPortMapping'],
          { getPortMapping: '' },
        );
        const listAfterAttempt = Array.isArray(afterAttempt.getPortMapping) ? afterAttempt.getPortMapping : [];
        const fallbackOk = await upsertWanRule(1, fallbackWan2, listAfterAttempt);
        usedFallbackPortWan2 = fallbackOk;
        finalMappings = await this.getPortMappings();
        wan2Rule =
          finalMappings.find(
            (m) =>
              m.wanId === 2 &&
              m.serverIp === ip &&
              m.externalPort === extPort &&
              m.internalPort === fallbackWan2 &&
              m.protocol === 1 &&
              m.enabled,
          ) ?? null;
      }

      const wan1Rule =
        finalMappings.find(
          (m) =>
            m.wanId === 1 &&
            m.serverIp === ip &&
            m.externalPort === extPort &&
            m.internalPort === intWan1 &&
            m.protocol === 1 &&
            m.enabled,
        ) ?? null;

      // Disable any leftover SSH rules on `ip` that do not match the active WAN1/WAN2 rule IDs
      const keepIds = new Set([wan1Rule?.id, wan2Rule?.id].filter((v): v is number => typeof v === 'number'));
      for (const m of finalMappings) {
        if (m.serverIp === ip && sshInternalPorts.has(m.internalPort) && m.enabled && !keepIds.has(m.id)) {
          await this.call(['setPortMapping'], {
            setPortMapping: { type: 'switch', data: { ID: m.id, portMappingEn: false } },
          });
        }
      }

      log.info('router: configured Dual-WAN SSH TCP port mapping', {
        targetIp: ip,
        externalPort: extPort,
        wan1Rule,
        wan2Rule,
        usedFallbackPortWan2,
      });

      return {
        ok: Boolean(wan1Rule),
        dmzDisabled,
        wan1Rule,
        wan2Rule,
        usedFallbackPortWan2,
      };
    });
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/** Parse Tenda flux strings like "0.13KB/s", "12.4MB/s", "5B/s" into bytes/sec. */
function parseFluxString(s: string | undefined): number {
  if (!s || typeof s !== 'string') return 0;
  const m = s.trim().match(/^([\d.]+)\s*(B|KB|MB|GB)\/s$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return 0;
  const u = m[2].toUpperCase();
  const mult = u === 'B' ? 1 : u === 'KB' ? 1024 : u === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;
  return Math.round(v * mult);
}

function parseCookieValue(setCookie: string, key: string): string | null {
  const segments = setCookie.split(/,(?=[^;]+=)/);
  for (const seg of segments) {
    const m = seg.match(new RegExp(`(?:^|; )${key}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}
