import type Database from 'better-sqlite3';
import { bucketHour, bucketDay, bucketMonth, DAY, HOUR, MIN, SEC } from '@tenda/shared';
import { log } from './logger.js';

export class RollupWorker {
  constructor(private readonly db: Database.Database) {}

  /** Roll all complete 5-min buckets older than `cutoff` into hourly buckets. */
  rollupHour(now: number): void {
    const cutoff = bucketHour(now); // hour that just ended is < this value
    const rows = this.db.prepare(`
      SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps
      FROM traffic_5min
      WHERE bucket_ts < ?
    `).all(cutoff) as Array<{
      mac: string; bucket_ts: number;
      bytes_down: number; bytes_up: number; active_sec: number;
      peak_down_bps: number | null; peak_up_bps: number | null;
    }>;
    if (rows.length === 0) return;

    const upsert = this.db.prepare(`
      INSERT INTO traffic_hour (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
      VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
      ON CONFLICT(mac, bucket_ts) DO UPDATE SET
        bytes_down   = bytes_down + excluded.bytes_down,
        bytes_up     = bytes_up   + excluded.bytes_up,
        active_sec   = active_sec + excluded.active_sec,
        peak_down_bps = MAX(COALESCE(peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
        peak_up_bps   = MAX(COALESCE(peak_up_bps, 0),   COALESCE(excluded.peak_up_bps, 0))
    `);

    const txn = this.db.transaction(() => {
      for (const r of rows) {
        upsert.run({
          mac: r.mac,
          bucket_ts: bucketHour(r.bucket_ts),
          bytes_down: r.bytes_down,
          bytes_up: r.bytes_up,
          active_sec: r.active_sec,
          peak_down_bps: r.peak_down_bps,
          peak_up_bps: r.peak_up_bps,
        });
      }
    });
    txn();

    log.info('rollup: hour', { rows: rows.length, cutoff });
  }

  rollupDay(now: number): void {
    const cutoff = bucketDay(now);
    const rows = this.db.prepare(`
      SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps
      FROM traffic_hour
      WHERE bucket_ts < ?
    `).all(cutoff) as any[];
    if (rows.length === 0) return;

    const upsert = this.db.prepare(`
      INSERT INTO traffic_day (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
      VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
      ON CONFLICT(mac, bucket_ts) DO UPDATE SET
        bytes_down   = bytes_down + excluded.bytes_down,
        bytes_up     = bytes_up   + excluded.bytes_up,
        active_sec   = active_sec + excluded.active_sec,
        peak_down_bps = MAX(COALESCE(peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
        peak_up_bps   = MAX(COALESCE(peak_up_bps, 0),   COALESCE(excluded.peak_up_bps, 0))
    `);
    const txn = this.db.transaction(() => {
      for (const r of rows) {
        upsert.run({
          mac: r.mac,
          bucket_ts: bucketDay(r.bucket_ts),
          bytes_down: r.bytes_down,
          bytes_up: r.bytes_up,
          active_sec: r.active_sec,
          peak_down_bps: r.peak_down_bps,
          peak_up_bps: r.peak_up_bps,
        });
      }
    });
    txn();
    log.info('rollup: day', { rows: rows.length });
  }

  rollupMonth(now: number): void {
    const cutoff = bucketMonth(now);
    const rows = this.db.prepare(`
      SELECT mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps
      FROM traffic_day
      WHERE bucket_ts < ?
    `).all(cutoff) as any[];
    if (rows.length === 0) return;

    const upsert = this.db.prepare(`
      INSERT INTO traffic_month (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
      VALUES (@mac, @bucket_ts, @bytes_down, @bytes_up, @active_sec, @peak_down_bps, @peak_up_bps)
      ON CONFLICT(mac, bucket_ts) DO UPDATE SET
        bytes_down   = bytes_down + excluded.bytes_down,
        bytes_up     = bytes_up   + excluded.bytes_up,
        active_sec   = active_sec + excluded.active_sec,
        peak_down_bps = MAX(COALESCE(peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
        peak_up_bps   = MAX(COALESCE(peak_up_bps, 0),   COALESCE(excluded.peak_up_bps, 0))
    `);
    const txn = this.db.transaction(() => {
      for (const r of rows) {
        upsert.run({
          mac: r.mac,
          bucket_ts: bucketMonth(r.bucket_ts),
          bytes_down: r.bytes_down,
          bytes_up: r.bytes_up,
          active_sec: r.active_sec,
          peak_down_bps: r.peak_down_bps,
          peak_up_bps: r.peak_up_bps,
        });
      }
    });
    txn();
    log.info('rollup: month', { rows: rows.length });
  }

  /** Retention prune. */
  pruneOld(now: number): void {
    const stmts = [
      [`DELETE FROM samples_raw WHERE ts < ?`, now - 48 * HOUR],
      [`DELETE FROM traffic_5min WHERE bucket_ts < ?`, now - 14 * DAY],
      [`DELETE FROM traffic_hour WHERE bucket_ts < ?`, now - 90 * DAY],
      [`DELETE FROM traffic_day WHERE bucket_ts < ?`, now - 730 * DAY],
      [`DELETE FROM router_state WHERE ts < ?`, now - 365 * DAY],
    ] as const;
    const txn = this.db.transaction(() => {
      for (const [sql, t] of stmts) this.db.prepare(sql).run(t);
    });
    txn();
    log.info('rollup: pruned old data');
  }
}
