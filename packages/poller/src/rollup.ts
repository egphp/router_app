import type Database from 'better-sqlite3';
import { bucketHour, bucketDay, bucketMonth, DAY, HOUR } from '@tenda/shared';
import { log } from './logger.js';

/**
 * Bucket promotion rules:
 *   traffic_5min  → traffic_hour   when bucket_ts < current hour
 *   traffic_hour  → traffic_day    when bucket_ts < current day
 *   traffic_day   → traffic_month  when bucket_ts < current month
 *
 * 5-minute source rows are deleted after hourly promotion. Hour/day rows are kept
 * for analytics, while day/month aggregates are replaced idempotently on each run.
 * Query code must avoid overlapping granularities when computing totals.
 */
export class RollupWorker {
  constructor(private readonly db: Database.Database) {}

  rollupHour(now: number): void {
    this.rollupGeneric({
      now,
      from: 'traffic_5min',
      to: 'traffic_hour',
      bucketFn: bucketHour,
      cutoff: bucketHour(now),
    });
  }

  rollupDay(now: number): void {
    this.rollupReplaceAggregate({
      now,
      from: 'traffic_hour',
      to: 'traffic_day',
      bucketFn: bucketDay,
      cutoff: bucketDay(now),
    });
  }

  rollupMonth(now: number): void {
    this.rollupReplaceAggregate({
      now,
      from: 'traffic_day',
      to: 'traffic_month',
      bucketFn: bucketMonth,
      cutoff: bucketMonth(now),
    });
  }

  private rollupGeneric(opts: {
    now: number;
    from: string;
    to: string;
    bucketFn: (ts: number) => number;
    cutoff: number;
  }): void {
    const rows = this.db.prepare(`
      SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps
      FROM ${opts.from} WHERE bucket_ts < ?
    `).all(opts.cutoff) as Array<{
      mac: string; bucket_ts: number;
      bytes_down: number; bytes_up: number; active_sec: number;
      peak_down_bps: number | null; peak_up_bps: number | null;
    }>;
    if (rows.length === 0) return;

    const upsert = this.db.prepare(`
      INSERT INTO ${opts.to} (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
      VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
      ON CONFLICT(mac, bucket_ts) DO UPDATE SET
        bytes_down   = bytes_down + excluded.bytes_down,
        bytes_up     = bytes_up   + excluded.bytes_up,
        active_sec   = active_sec + excluded.active_sec,
        peak_down_bps = MAX(COALESCE(peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
        peak_up_bps   = MAX(COALESCE(peak_up_bps, 0),   COALESCE(excluded.peak_up_bps, 0))
    `);

    const deleteSrc = this.db.prepare(`DELETE FROM ${opts.from} WHERE bucket_ts < ?`);

    const txn = this.db.transaction(() => {
      for (const r of rows) {
        upsert.run({
          mac: r.mac,
          bucket_ts: opts.bucketFn(r.bucket_ts),
          bytes_down: r.bytes_down,
          bytes_up: r.bytes_up,
          active_sec: r.active_sec,
          peak_down_bps: r.peak_down_bps,
          peak_up_bps: r.peak_up_bps,
        });
      }
      // Critical: delete the source rows we just rolled up so we never double-count.
      deleteSrc.run(opts.cutoff);
    });
    txn();

    log.info(`rollup: ${opts.from} → ${opts.to}`, { rows: rows.length, cutoff: opts.cutoff });
  }

  private rollupReplaceAggregate(opts: {
    now: number;
    from: string;
    to: string;
    bucketFn: (ts: number) => number;
    cutoff: number;
  }): void {
    const rows = this.db.prepare(`
      SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps
      FROM ${opts.from} WHERE bucket_ts < ?
    `).all(opts.cutoff) as Array<{
      mac: string; bucket_ts: number;
      bytes_down: number; bytes_up: number; active_sec: number;
      peak_down_bps: number | null; peak_up_bps: number | null;
    }>;
    if (rows.length === 0) return;

    const grouped = new Map<string, {
      mac: string; bucket_ts: number; bytes_down: number; bytes_up: number; active_sec: number;
      peak_down_bps: number; peak_up_bps: number;
    }>();
    for (const r of rows) {
      const bucketTs = opts.bucketFn(r.bucket_ts);
      const key = `${r.mac}|${bucketTs}`;
      const g = grouped.get(key) ?? {
        mac: r.mac,
        bucket_ts: bucketTs,
        bytes_down: 0,
        bytes_up: 0,
        active_sec: 0,
        peak_down_bps: 0,
        peak_up_bps: 0,
      };
      g.bytes_down += Number(r.bytes_down ?? 0);
      g.bytes_up += Number(r.bytes_up ?? 0);
      g.active_sec += Number(r.active_sec ?? 0);
      g.peak_down_bps = Math.max(g.peak_down_bps, Number(r.peak_down_bps ?? 0));
      g.peak_up_bps = Math.max(g.peak_up_bps, Number(r.peak_up_bps ?? 0));
      grouped.set(key, g);
    }

    const upsert = this.db.prepare(`
      INSERT INTO ${opts.to} (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
      VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
      ON CONFLICT(mac, bucket_ts) DO UPDATE SET
        bytes_down = excluded.bytes_down,
        bytes_up = excluded.bytes_up,
        active_sec = excluded.active_sec,
        peak_down_bps = excluded.peak_down_bps,
        peak_up_bps = excluded.peak_up_bps
    `);

    const txn = this.db.transaction(() => {
      for (const g of grouped.values()) upsert.run(g);
    });
    txn();

    log.info(`rollup: ${opts.from} → ${opts.to} replaced`, { rows: rows.length, groups: grouped.size, cutoff: opts.cutoff });
  }

  /** Retention prune. Keep raw samples 48h; rolled buckets are kept by their next-level table. */
  pruneOld(now: number): void {
    const stmts = [
      [`DELETE FROM samples_raw WHERE ts < ?`, now - 48 * HOUR],
      [`DELETE FROM router_state WHERE ts < ?`, now - 365 * DAY],
      [`DELETE FROM router_log WHERE ts < ?`, now - 365 * DAY],
    ] as const;
    const txn = this.db.transaction(() => {
      for (const [sql, t] of stmts) {
        try { this.db.prepare(sql).run(t); } catch {}
      }
    });
    txn();
    log.info('rollup: pruned old data');
  }

  /** One-time repair: detect double-counted data from the old rollup bug and clean it. */
  repairDoubleCounting(now: number): void {
    // If there are rows in both traffic_5min and traffic_hour for the same (mac, hour),
    // the hour row was created without deleting the 5min source. Heuristic fix:
    // for every 5min bucket that falls inside an existing hour bucket, delete the 5min.
    const r = this.db.prepare(`
      DELETE FROM traffic_5min
      WHERE bucket_ts < ? AND EXISTS (
        SELECT 1 FROM traffic_hour h
        WHERE h.mac = traffic_5min.mac
          AND h.bucket_ts = ((traffic_5min.bucket_ts / ${HOUR}) * ${HOUR})
      )
    `).run(bucketHour(now));
    if (r.changes > 0) log.warn('repair: pruned double-counted 5min rows', { changes: r.changes });
  }
}
