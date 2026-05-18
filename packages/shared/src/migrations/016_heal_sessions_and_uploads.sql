-- One-time repair after fixes for:
--  (a) inferSessionStart using the wrong unit (treated onlineTime seconds as minutes,
--      pushing device_sessions.started_at 60× too far back into the past). Open
--      sessions then accumulated bytes that did not belong to the actual session.
--  (b) upload integration in the accumulator using trapezoidal mean of instantaneous
--      KB/s samples. A burst peak at sample time was extrapolated over the full
--      sample interval, inflating bytes_up across traffic_5min / traffic_hour /
--      traffic_day. The fix uses min-of-pair, but the historical buckets are still
--      inflated. We clamp them with conservative caps (same approach as migration
--      007). Genuine outliers above the caps are vanishingly rare in home networks.
--
-- Caps are in BYTES.
--   5-min bucket   bytes_up cap  =  500 MB  (sustained 1.66 MB/s ≈ 13 Mbps for 5 min)
--   hour  bucket   bytes_up cap  =    5 GB  (sustained 1.42 MB/s for the whole hour)
--   day   bucket   bytes_up cap  =   50 GB  (very few residential lines reach this)
-- We do NOT clamp bytes_down because the download counter from the router is the
-- ground truth; migration 007 already clamped its historical inflation.

UPDATE traffic_5min  SET bytes_up =  500 * 1024 * 1024              WHERE bytes_up >  500 * 1024 * 1024;
UPDATE traffic_hour  SET bytes_up =    5 * 1024 * 1024 * 1024       WHERE bytes_up >    5 * 1024 * 1024 * 1024;
UPDATE traffic_day   SET bytes_up =   50 * 1024 * 1024 * 1024       WHERE bytes_up >   50 * 1024 * 1024 * 1024;
UPDATE traffic_month SET bytes_up = 1500 * 1024 * 1024 * 1024       WHERE bytes_up > 1500 * 1024 * 1024 * 1024;

-- Heal device_sessions.started_at for OPEN sessions only: if started_at falls
-- before the earliest sample we have for that MAC, clamp it to that earliest
-- sample. We can't reconstruct the true start before samples_raw started
-- (pruned at 48h), but at least we stop attributing bytes from before the
-- device's own first observed sample to this session. We avoid touching
-- closed sessions because their started_at is part of the PRIMARY KEY and a
-- bulk UPDATE can collide with another session for the same MAC.
UPDATE device_sessions AS ds
SET started_at = COALESCE(
  (SELECT MIN(sr.ts) FROM samples_raw sr WHERE sr.mac = ds.mac),
  ds.started_at
)
WHERE ds.ended_at IS NULL
  AND EXISTS (SELECT 1 FROM samples_raw sr WHERE sr.mac = ds.mac)
  AND ds.started_at < (SELECT MIN(sr.ts) FROM samples_raw sr WHERE sr.mac = ds.mac)
  AND NOT EXISTS (
    -- skip if a different (closed) session for the same MAC already occupies
    -- the target started_at, which would violate PRIMARY KEY.
    SELECT 1 FROM device_sessions ds2
    WHERE ds2.mac = ds.mac
      AND ds2.started_at = (SELECT MIN(sr.ts) FROM samples_raw sr WHERE sr.mac = ds.mac)
      AND ds2.ended_at IS NOT NULL
  );

-- Recompute open sessions' bytes_down / bytes_up from the traffic rollups so the
-- "all-time" total stops carrying the historical over-counts. We sum across
-- traffic_5min/hour/day/month — same UNION ALL pattern queries.ts already uses
-- with non-overlapping bucket_ts ranges.
UPDATE device_sessions
SET bytes_down = COALESCE((
      SELECT SUM(bd) FROM (
        SELECT SUM(bytes_down) AS bd FROM traffic_5min  WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
        UNION ALL
        SELECT SUM(bytes_down) AS bd FROM traffic_hour  WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
        UNION ALL
        SELECT SUM(bytes_down) AS bd FROM traffic_day   WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
        UNION ALL
        SELECT SUM(bytes_down) AS bd FROM traffic_month WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
      )
    ), 0),
    bytes_up = COALESCE((
      SELECT SUM(bu) FROM (
        SELECT SUM(bytes_up) AS bu FROM traffic_5min  WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
        UNION ALL
        SELECT SUM(bytes_up) AS bu FROM traffic_hour  WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
        UNION ALL
        SELECT SUM(bytes_up) AS bu FROM traffic_day   WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
        UNION ALL
        SELECT SUM(bytes_up) AS bu FROM traffic_month WHERE mac = device_sessions.mac AND bucket_ts >= device_sessions.started_at
      )
    ), 0)
WHERE ended_at IS NULL;
