import type Database from 'better-sqlite3';
import { insertAlertIfAllowed, sendOutagePush } from '@tenda/shared';
import { log } from './logger.js';

export type OutageReason = 'unreachable' | 'auth_fail' | 'router_reboot';

export class OutageMonitor {
  private consecutiveFailures = 0;
  private openOutageStart: number | null = null;

  private insertOutage: Database.Statement;
  private closeOutage: Database.Statement;
  private insertAlert: Database.Statement;
  private findOpen: Database.Statement;

  constructor(private readonly db: Database.Database, private readonly failureThreshold = 3) {
    this.insertOutage = db.prepare(`INSERT OR REPLACE INTO outages (started_at, ended_at, reason, notes) VALUES (?, NULL, ?, ?)`);
    this.closeOutage = db.prepare(`UPDATE outages SET ended_at = ? WHERE started_at = ?`);
    this.insertAlert = db.prepare(`INSERT INTO alerts (kind, mac, payload, created_at) VALUES (?, NULL, ?, ?)`);
    this.findOpen = db.prepare(`SELECT started_at FROM outages WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`);

    // Recover any open outage on restart
    const open = this.findOpen.get() as { started_at: number } | undefined;
    if (open) this.openOutageStart = open.started_at;
  }

  recordFailure(now: number, reason: OutageReason, notes?: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold && !this.openOutageStart) {
      this.openOutageStart = now;
      this.insertOutage.run(now, reason, notes ?? null);
      const alert = insertAlertIfAllowed(this.db, 'outage', null, { started_at: now, reason, notes }, now);
      if (alert.inserted) {
        void sendOutagePush(this.db, { kind: 'outage', reason, notes: notes ?? null, startedAt: now })
          .then((result) => log.warn('outage push result', result))
          .catch((error) => log.warn('outage push failed', String(error)));
      }
      log.warn('outage opened', { reason, notes });
    }
  }

  recordSuccess(now: number): void {
    this.consecutiveFailures = 0;
    if (this.openOutageStart) {
      this.closeOutage.run(now, this.openOutageStart);
      log.info('outage closed', { started_at: this.openOutageStart, duration_s: Math.round((now - this.openOutageStart) / 1000) });
      this.openOutageStart = null;
    }
  }

  recordReboot(now: number, uptimeBefore: number, uptimeAfter: number): void {
    const reboot_start = now - (uptimeAfter * 1000);
    this.insertOutage.run(reboot_start, 'router_reboot', JSON.stringify({ uptimeBefore, uptimeAfter }));
    this.closeOutage.run(now, reboot_start);
    const alert = insertAlertIfAllowed(this.db, 'reboot', null, { uptimeBefore, uptimeAfter }, now);
    if (alert.inserted) {
      void sendOutagePush(this.db, { kind: 'reboot', uptimeBefore, uptimeAfter })
        .then((result) => log.warn('reboot push result', result))
        .catch((error) => log.warn('reboot push failed', String(error)));
    }
    log.warn('router reboot detected', { uptimeBefore, uptimeAfter });
  }

  isInOutage(): boolean {
    return this.openOutageStart !== null;
  }
}
