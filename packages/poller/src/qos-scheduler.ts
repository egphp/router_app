import type Database from 'better-sqlite3';
import type { RouterClient } from './router-client.js';
import { isValidLanIpv4 } from './traffic-control.js';
import { log } from './logger.js';

export interface QosScheduleRow {
  id: number;
  name: string;
  natural_prompt: string | null;
  days_mask: string;
  start_hhmm: string;
  end_hhmm: string;
  target_selector_json: string;
  download_limit_kbs: number;
  upload_limit_kbs: number;
  wan_port: number | null;
  enabled: number;
  last_applied_state: string | null;
  created_at: number;
  updated_at: number;
}

interface AppliedDeviceSnapshot {
  mac: string;
  ip: string | null;
  prevDownKbs: number;
  prevUpKbs: number;
  prevWanPort: string | null;
}

interface StoredScheduleState {
  active: boolean;
  appliedAt: number;
  devices: AppliedDeviceSnapshot[];
}

export function isTimeInScheduleWindow(now: Date, daysMask: string, startHhmm: string, endHhmm: string): boolean {
  const allowedDays = new Set(
    daysMask
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  );
  if (allowedDays.size === 0) return false;

  const [sh, sm] = startHhmm.split(':').map(Number);
  const [eh, em] = endHhmm.split(':').map(Number);
  if (!Number.isFinite(sh) || !Number.isFinite(sm) || !Number.isFinite(eh) || !Number.isFinite(em)) {
    return false;
  }
  const startMin = sh! * 60 + sm!;
  const endMin = eh! * 60 + em!;
  const curMin = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();

  if (startMin === endMin) return allowedDays.has(today);
  if (startMin < endMin) {
    return allowedDays.has(today) && curMin >= startMin && curMin < endMin;
  }
  // Cross-midnight window (e.g. 23:00 -> 06:00)
  if (curMin >= startMin) {
    return allowedDays.has(today);
  }
  const yesterday = (today + 6) % 7;
  return curMin < endMin && allowedDays.has(yesterday);
}

export class QosScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database.Database,
    private readonly router: Pick<RouterClient, 'setDeviceSpeedLimit' | 'setDeviceWanBinding'>,
    private readonly onStateMutated?: () => Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => log.warn('qos-scheduler tick error', String(e)));
    }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(nowMs = Date.now()): Promise<{ applied: number; reverted: number }> {
    if (this.running) return { applied: 0, reverted: 0 };
    const hasSchedules = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ai_qos_schedules'`)
      .get() as { ok: number } | undefined;
    if (!hasSchedules?.ok) return { applied: 0, reverted: 0 };

    this.running = true;
    let applied = 0;
    let reverted = 0;
    try {
      const rows = this.db.prepare(`SELECT * FROM ai_qos_schedules ORDER BY id ASC`).all() as QosScheduleRow[];
      const nowDate = new Date(nowMs);

      for (const row of rows) {
        const prevState = parseStoredState(row.last_applied_state);
        const shouldBeActive =
          row.enabled === 1 && isTimeInScheduleWindow(nowDate, row.days_mask, row.start_hhmm, row.end_hhmm);

        if (shouldBeActive && !prevState?.active) {
          const snap = await this.applySchedule(row);
          this.db
            .prepare(`UPDATE ai_qos_schedules SET last_applied_state = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify({ active: true, appliedAt: nowMs, devices: snap } satisfies StoredScheduleState), nowMs, row.id);
          applied += 1;
        } else if (!shouldBeActive && prevState?.active) {
          await this.revertSchedule(prevState);
          this.db
            .prepare(`UPDATE ai_qos_schedules SET last_applied_state = NULL, updated_at = ? WHERE id = ?`)
            .run(nowMs, row.id);
          reverted += 1;
        }
      }

      if ((applied > 0 || reverted > 0) && this.onStateMutated) {
        await this.onStateMutated().catch(() => {});
      }
      return { applied, reverted };
    } finally {
      this.running = false;
    }
  }

  private resolveTargetDevices(selectorJson: string): Array<{
    mac: string;
    ip: string | null;
    label: string;
    curDownKbs: number;
    curUpKbs: number;
    curWanPort: string | null;
  }> {
    let selector: { categories?: string[]; macs?: string[] } = {};
    try {
      selector = JSON.parse(selectorJson);
    } catch {}
    const cats = new Set((selector.categories ?? []).map((c) => c.toLowerCase()));
    const macs = new Set((selector.macs ?? []).map((m) => m.toUpperCase()));

    const all = this.db
      .prepare(`
        SELECT d.mac,
               COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
               LOWER(COALESCE(d.category, '')) AS cat,
               COALESCE(q.ip, (SELECT s.ip FROM samples_raw s WHERE s.mac = d.mac AND s.ip IS NOT NULL ORDER BY s.ts DESC LIMIT 1)) AS ip,
               COALESCE(q.download_limit_kbs, 0) AS cur_down,
               COALESCE(q.upload_limit_kbs, 0) AS cur_up,
               wb.wan_port AS cur_wan
        FROM devices d
        LEFT JOIN router_qos_limits q ON q.mac = d.mac
        LEFT JOIN router_wan_bindings wb ON wb.ip = q.ip AND wb.inherited_from_range = 0 AND wb.rule_enabled = 1
      `)
      .all() as Array<{
      mac: string;
      label: string;
      cat: string;
      ip: string | null;
      cur_down: number;
      cur_up: number;
      cur_wan: string | null;
    }>;

    return all
      .filter((d) => macs.has(d.mac.toUpperCase()) || (d.cat && cats.has(d.cat)))
      .slice(0, 25)
      .map((d) => ({
        mac: d.mac.toUpperCase(),
        ip: d.ip,
        label: d.label,
        curDownKbs: Number(d.cur_down ?? 0),
        curUpKbs: Number(d.cur_up ?? 0),
        curWanPort: d.cur_wan ?? null,
      }));
  }

  private async applySchedule(row: QosScheduleRow): Promise<AppliedDeviceSnapshot[]> {
    const targets = this.resolveTargetDevices(row.target_selector_json);
    const snapshots: AppliedDeviceSnapshot[] = [];
    for (const dev of targets) {
      try {
        await this.router.setDeviceSpeedLimit({
          mac: dev.mac,
          downloadLimitKBs: row.download_limit_kbs,
          uploadLimitKBs: row.upload_limit_kbs,
        });
        if ((row.wan_port === 1 || row.wan_port === 2) && dev.ip && isValidLanIpv4(dev.ip)) {
          await this.router.setDeviceWanBinding({
            ip: dev.ip,
            labelHint: dev.label,
            wanPort: `WAN${row.wan_port}`,
          });
        }
        snapshots.push({
          mac: dev.mac,
          ip: dev.ip,
          prevDownKbs: dev.curDownKbs,
          prevUpKbs: dev.curUpKbs,
          prevWanPort: dev.curWanPort,
        });
      } catch (e) {
        log.warn('qos-scheduler apply failed for device', { scheduleId: row.id, mac: dev.mac, err: String(e) });
      }
    }
    return snapshots;
  }

  private async revertSchedule(state: StoredScheduleState): Promise<void> {
    for (const snap of state.devices) {
      try {
        await this.router.setDeviceSpeedLimit({
          mac: snap.mac,
          downloadLimitKBs: snap.prevDownKbs,
          uploadLimitKBs: snap.prevUpKbs,
        });
        if (snap.ip && isValidLanIpv4(snap.ip) && snap.prevWanPort) {
          await this.router.setDeviceWanBinding({
            ip: snap.ip,
            wanPort: snap.prevWanPort,
          });
        }
      } catch (e) {
        log.warn('qos-scheduler revert failed for device', { mac: snap.mac, err: String(e) });
      }
    }
  }
}

function parseStoredState(raw: string | null): StoredScheduleState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StoredScheduleState;
    return p && typeof p === 'object' && Array.isArray(p.devices) ? p : null;
  } catch {
    return null;
  }
}
