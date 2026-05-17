import type Database from 'better-sqlite3';
import { RouterClient, AuthError } from './router-client.js';
import { Accumulator } from './accumulator.js';
import { WanAccumulator } from './wan-accumulator.js';
import { OutageMonitor } from './outage.js';
import { RollupWorker } from './rollup.js';
import { IpcBroadcaster } from './ipc.js';
import { SecurityScanner } from './security.js';
import { SystemLogPuller } from './system-log-puller.js';
import { NsfwScanner } from './nsfw-scanner.js';
import { ThresholdAlertMonitor } from './threshold-alerts.js';
import { parseRouterUptime, MIN, sendNewDevicePush, sendNsfwPush, sendSecurityPush, lookupOui, categorizeByName } from '@tenda/shared';
import { log } from './logger.js';

export interface RouterTelemetry {
  ts: number;
  sysInfo: { cpuUsage?: number; memUsage?: number; firmware?: string; model?: string; raw: Record<string, unknown> };
  wanFlow: Array<Record<string, unknown>>;
}

export class Sampler {
  private timer: NodeJS.Timeout | null = null;
  private rollupTimer: NodeJS.Timeout | null = null;
  private logPullTimer: NodeJS.Timeout | null = null;
  private lastUptimeSec = 0;
  private accumulator: Accumulator;
  private wanAccumulator: WanAccumulator;
  private outage: OutageMonitor;
  private rollup: RollupWorker;
  private security: SecurityScanner;
  private logPuller: SystemLogPuller;
  private nsfw: NsfwScanner;
  private thresholds: ThresholdAlertMonitor;
  private telemetry: RouterTelemetry | null = null;

  private insertRouterState: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly router: RouterClient,
    private readonly ipc: IpcBroadcaster,
    private readonly intervalMs: number,
  ) {
    this.accumulator = new Accumulator(db);
    this.wanAccumulator = new WanAccumulator(db);
    this.outage = new OutageMonitor(db);
    this.rollup = new RollupWorker(db);
    this.security = new SecurityScanner(db);
    this.logPuller = new SystemLogPuller(db, router);
    this.nsfw = new NsfwScanner(db);
    this.thresholds = new ThresholdAlertMonitor(db);
    this.insertRouterState = db.prepare(`
      INSERT OR REPLACE INTO router_state (ts, uptime_sec, is_reboot, online_count) VALUES (?, ?, ?, ?)
    `);

    const lastState = db.prepare(`SELECT uptime_sec FROM router_state ORDER BY ts DESC LIMIT 1`).get() as { uptime_sec: number } | undefined;
    if (lastState) this.lastUptimeSec = lastState.uptime_sec;
  }

  start(): void {
    this.runCycle().catch((e) => log.error('initial cycle error', String(e)));
    this.timer = setInterval(() => {
      this.runCycle().catch((e) => log.error('cycle error', String(e)));
    }, this.intervalMs);
    this.rollupTimer = setInterval(() => this.runRollups(), 5 * MIN);
    // Pull router's own system/attack log every 2 minutes
    this.logPuller.pull().catch((e) => log.warn('initial log pull error', String(e)));
    this.logPullTimer = setInterval(() => {
      this.logPuller.pull().catch((e) => log.warn('log pull error', String(e)));
    }, 2 * MIN);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.rollupTimer) { clearInterval(this.rollupTimer); this.rollupTimer = null; }
    if (this.logPullTimer) { clearInterval(this.logPullTimer); this.logPullTimer = null; }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getTelemetry(): RouterTelemetry | null {
    return this.telemetry;
  }

  private async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    try {
      const status = await this.router.getSystemStatus();
      const uptimeSec = parseRouterUptime(status.runTime);
      const now = Date.now();

      let isReboot = false;
      if (this.lastUptimeSec > 0 && uptimeSec < this.lastUptimeSec) {
        isReboot = true;
        this.outage.recordReboot(now, this.lastUptimeSec, uptimeSec);
      }
      this.insertRouterState.run(now, uptimeSec, isReboot ? 1 : 0, status.onlineHostCount);
      this.lastUptimeSec = uptimeSec;

      const [devices, wanFlux] = await Promise.all([
        this.router.getDeviceList(),
        this.router.getWanFlux(),
      ]);
      const result = this.accumulator.process(now, devices, isReboot);
      const wanResult = this.wanAccumulator.process(now, wanFlux);

      // NSFW URL detection (cheap; only scans new syslog rows since last tick).
      const nsfwResult = this.nsfw.scan(now);
      if (nsfwResult.pushCandidates.length > 0) {
        void this.sendNsfwNotifications(nsfwResult.pushCandidates).catch((e) => {
          log.warn('nsfw push notification failed', String(e));
        });
      }

      // Security checks every cycle (with internal dedupe).
      const sec = this.security.scan(now, devices);
      if (sec.length > 0) {
        log.warn('security checks fired', { count: sec.length, rules: [...new Set(sec.map(s => s.rule))] });
        void this.sendSecurityNotifications(sec).catch((e) => {
          log.warn('security push notification failed', String(e));
        });
      }

      void this.thresholds.scan(now).catch((e) => {
        log.warn('threshold notification scan failed', String(e));
      });

      this.outage.recordSuccess(now);
      this.ipc.broadcast({ type: 'samples-updated', ts: now, deviceCount: result.deviceCount });
      if (result.newDevices.length > 0) {
        log.info('new devices detected', { macs: result.newDevices });
        void this.sendNewDeviceNotifications(result.newDevices, devices).catch((e) => {
          log.warn('new-device push notification failed', String(e));
        });
      }

      // Extended telemetry: pull CPU/RAM + WAN flow opportunistically (every cycle).
      // Errors are swallowed inside the methods; cache is best-effort.
      try {
        const [sysInfo, wanFlow] = await Promise.all([
          this.router.getSysInfo(),
          this.router.getWanFlow(),
        ]);
        this.telemetry = { ts: now, sysInfo, wanFlow };
      } catch {
        // keep previous telemetry
      }

      const elapsed = Date.now() - cycleStart;
      log.debug('cycle ok', {
        elapsed_ms: elapsed,
        devices: result.deviceCount,
        new: result.newDevices.length,
        deltaDownMB: (result.totalBytesDownDelta / 1024 / 1024).toFixed(2),
        deltaUpKB: (result.totalBytesUpDelta / 1024).toFixed(2),
        wanDownKB: (wanResult.bytesDown / 1024).toFixed(2),
        wanUpKB: (wanResult.bytesUp / 1024).toFixed(2),
        is_reboot: isReboot,
      });
    } catch (err) {
      const now = Date.now();
      const reason = err instanceof AuthError ? 'auth_fail' : 'unreachable';
      this.outage.recordFailure(now, reason, String(err));
      log.warn('cycle failed', { reason, err: String(err) });
    }
  }

  private runRollups(): void {
    const now = Date.now();
    try {
      this.rollup.repairDoubleCounting(now);
      this.rollup.rollupHour(now);
      this.rollup.rollupDay(now);
      this.rollup.rollupMonth(now);
      const h = new Date().getHours();
      if (h === 3) this.rollup.pruneOld(now);
    } catch (e) {
      log.error('rollup failed', String(e));
    }
  }

  private async sendNewDeviceNotifications(newMacs: string[], devices: Array<{ hostMAC?: string; hostName?: string; hostIP?: string }>): Promise<void> {
    const byMac = new Map<string, { hostMAC?: string; hostName?: string; hostIP?: string }>();
    for (const device of devices) {
      const mac = normalizeMac(device.hostMAC);
      if (mac) byMac.set(mac, device);
    }
    for (const mac of newMacs) {
      const normalized = normalizeMac(mac);
      if (!normalized) continue;
      const device = byMac.get(normalized);
      const oui = lookupOui(normalized);
      const result = await sendNewDevicePush(this.db, {
        mac: normalized,
        hostname: device?.hostName ?? null,
        ip: device?.hostIP ?? null,
        vendor: oui.vendor,
        category: categorizeByName(device?.hostName) ?? oui.category ?? null,
      });
      log.info('new-device push result', { mac: normalized, ...result });
    }
  }

  private async sendNsfwNotifications(hits: Array<{ mac: string | null; ip: string | null; domain: string; category: string }>): Promise<void> {
    for (const hit of hits) {
      const result = await sendNsfwPush(this.db, hit);
      log.warn('nsfw push result', { mac: hit.mac, ip: hit.ip, domain: hit.domain, ...result });
    }
  }

  private async sendSecurityNotifications(checks: Array<{ rule: string; severity: string; mac: string | null; message: string; detail?: any }>): Promise<void> {
    for (const check of checks) {
      const result = await sendSecurityPush(this.db, {
        rule: check.rule,
        severity: check.severity,
        mac: check.mac,
        message: check.message,
        ip: check.detail?.ip ?? null,
      });
      log.warn('security push result', { rule: check.rule, mac: check.mac, ...result });
    }
  }
}

function normalizeMac(value: unknown): string {
  if (typeof value !== 'string') return '';
  const mac = value.trim().toUpperCase();
  return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) ? mac : '';
}
