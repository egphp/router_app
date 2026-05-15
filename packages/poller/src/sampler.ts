import type Database from 'better-sqlite3';
import { RouterClient, AuthError } from './router-client.js';
import { Accumulator } from './accumulator.js';
import { OutageMonitor } from './outage.js';
import { RollupWorker } from './rollup.js';
import { IpcBroadcaster } from './ipc.js';
import { parseRouterUptime, MIN, HOUR, DAY } from '@tenda/shared';
import { log } from './logger.js';

export class Sampler {
  private timer: NodeJS.Timeout | null = null;
  private rollupTimer: NodeJS.Timeout | null = null;
  private lastUptimeSec = 0;
  private accumulator: Accumulator;
  private outage: OutageMonitor;
  private rollup: RollupWorker;

  private insertRouterState: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly router: RouterClient,
    private readonly ipc: IpcBroadcaster,
    private readonly intervalMs: number,
  ) {
    this.accumulator = new Accumulator(db);
    this.outage = new OutageMonitor(db);
    this.rollup = new RollupWorker(db);
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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.rollupTimer) clearInterval(this.rollupTimer);
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

      const devices = await this.router.getDeviceList();
      const result = this.accumulator.process(now, devices, isReboot);

      this.outage.recordSuccess(now);
      this.ipc.broadcast({ type: 'samples-updated', ts: now, deviceCount: result.deviceCount });
      if (result.newDevices.length > 0) {
        log.info('new devices detected', { macs: result.newDevices });
      }

      const elapsed = Date.now() - cycleStart;
      log.debug('cycle ok', {
        elapsed_ms: elapsed,
        devices: result.deviceCount,
        new: result.newDevices.length,
        deltaDownMB: (result.totalBytesDownDelta / 1024 / 1024).toFixed(2),
        deltaUpKB: (result.totalBytesUpDelta / 1024).toFixed(2),
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
      this.rollup.rollupHour(now);
      this.rollup.rollupDay(now);
      this.rollup.rollupMonth(now);
      // Prune nightly (around 03:00 local) — cheap to call every 5 min, just gates on hour
      const h = new Date().getHours();
      if (h === 3) this.rollup.pruneOld(now);
    } catch (e) {
      log.error('rollup failed', String(e));
    }
  }
}
