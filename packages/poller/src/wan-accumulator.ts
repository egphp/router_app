import type Database from 'better-sqlite3';
import { bucket5Min, bucketDay } from '@tenda/shared';
import { log } from './logger.js';

interface PrevWan {
  ts: number;
  up_bps: number;
  down_bps: number;
}

/**
 * Integrates WAN-level instantaneous flux (bytes/sec) over time into authoritative
 * cumulative byte counters. Unlike per-device upload (estimated from KB/s integer values),
 * WAN flux is reported as fractional KB/s strings ("0.13KB/s") so the integration is more
 * accurate. There are typically 1 or 2 WAN ports on a dual-WAN Tenda.
 */
export class WanAccumulator {
  private insertSample: Database.Statement;
  private lastSample: Database.Statement;
  private upsert5min: Database.Statement;
  private upsertDay: Database.Statement;
  private prev: Map<number, PrevWan> = new Map();

  constructor(private readonly db: Database.Database) {
    this.insertSample = db.prepare(`
      INSERT OR REPLACE INTO wan_samples (ts, wan_id, up_bytes_per_s, down_bytes_per_s)
      VALUES (@ts, @wan_id, @up, @down)
    `);
    this.lastSample = db.prepare(`
      SELECT ts, up_bytes_per_s AS up_bps, down_bytes_per_s AS down_bps
      FROM wan_samples WHERE wan_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1
    `);
    this.upsert5min = db.prepare(`
      INSERT INTO wan_traffic_5min (bucket_ts, bytes_up, bytes_down, sample_count)
      VALUES (@bucket_ts, @bytes_up, @bytes_down, 1)
      ON CONFLICT(bucket_ts) DO UPDATE SET
        bytes_up = bytes_up + excluded.bytes_up,
        bytes_down = bytes_down + excluded.bytes_down,
        sample_count = sample_count + 1
    `);
    this.upsertDay = db.prepare(`
      INSERT INTO wan_traffic_day (bucket_ts, bytes_up, bytes_down)
      VALUES (@bucket_ts, @bytes_up, @bytes_down)
      ON CONFLICT(bucket_ts) DO UPDATE SET
        bytes_up = bytes_up + excluded.bytes_up,
        bytes_down = bytes_down + excluded.bytes_down
    `);
  }

  process(now: number, wans: Array<{ id: number; upBps: number; downBps: number }>): { bytesUp: number; bytesDown: number } {
    let totalUp = 0;
    let totalDown = 0;

    const txn = this.db.transaction(() => {
      for (const w of wans) {
        this.insertSample.run({ ts: now, wan_id: w.id, up: w.upBps, down: w.downBps });

        const prev = this.prev.get(w.id) ?? (this.lastSample.get(w.id, now) as PrevWan | undefined);
        if (prev) {
          const dtSec = Math.max(1, Math.round((now - prev.ts) / 1000));
          // Skip if gap is too large — likely a poller restart, don't synthesize traffic.
          if (dtSec <= 5 * 60) {
            const bytesUp = Math.round(((prev.up_bps + w.upBps) / 2) * dtSec);
            const bytesDown = Math.round(((prev.down_bps + w.downBps) / 2) * dtSec);
            totalUp += bytesUp;
            totalDown += bytesDown;
            const bucket = bucket5Min(now);
            const day = bucketDay(now);
            this.upsert5min.run({ bucket_ts: bucket, bytes_up: bytesUp, bytes_down: bytesDown });
            this.upsertDay.run({ bucket_ts: day, bytes_up: bytesUp, bytes_down: bytesDown });
          } else {
            log.info('wan-accumulator: gap too large, re-baselining', { wan_id: w.id, dtSec });
          }
        }
        this.prev.set(w.id, { ts: now, up_bps: w.upBps, down_bps: w.downBps });
      }
    });
    txn();

    return { bytesUp: totalUp, bytesDown: totalDown };
  }
}
