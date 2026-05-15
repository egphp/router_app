-- One-time self-heal for users updating from versions before the counter-flicker fix.
--
-- The old accumulator credited prev.down_sum_kb + curr.down_sum_kb whenever the
-- per-device counter regressed (Tenda firmware sometimes flickers it to 0 even
-- when the device stays online). Repeated flickers compounded: a device with a
-- 5 MB counter could be credited 5 MB on every flicker cycle, producing tens of
-- GB per day of phantom traffic in traffic_5min / traffic_hour / traffic_day.
--
-- We can't reconstruct the true historical bytes — the only ground truth is the
-- router's cumulative counter, which we may have already lost from samples_raw
-- (it's pruned at 48 h). So we clamp obviously-impossible bucket values to a
-- conservative cap. Real residential traffic almost never hits these caps:
--   - 5 GB in a single 5-min bucket  (= sustained 16 MB/s, faster than most home internet)
--   - 50 GB in a single hourly bucket (= sustained 14 MB/s for the whole hour)
--   - 500 GB in a single daily bucket (very few homes ever do this)
-- Genuine outliers above these thresholds are also possible but vanishingly rare,
-- and we'd rather slightly under-count one extraordinary day than carry forward
-- runaway phantom totals.

UPDATE traffic_5min  SET bytes_down = 5  * 1024 * 1024 * 1024 WHERE bytes_down > 5  * 1024 * 1024 * 1024;
UPDATE traffic_5min  SET bytes_up   = 5  * 1024 * 1024 * 1024 WHERE bytes_up   > 5  * 1024 * 1024 * 1024;
UPDATE traffic_hour  SET bytes_down = 50 * 1024 * 1024 * 1024 WHERE bytes_down > 50 * 1024 * 1024 * 1024;
UPDATE traffic_hour  SET bytes_up   = 50 * 1024 * 1024 * 1024 WHERE bytes_up   > 50 * 1024 * 1024 * 1024;
UPDATE traffic_day   SET bytes_down = 500 * 1024 * 1024 * 1024 WHERE bytes_down > 500 * 1024 * 1024 * 1024;
UPDATE traffic_day   SET bytes_up   = 500 * 1024 * 1024 * 1024 WHERE bytes_up   > 500 * 1024 * 1024 * 1024;
