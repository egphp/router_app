-- Clean up AICsemi AIC8800 Wi-Fi boot-fallback phantom MACs (88:00:33:77:XX:XX)
-- generated when Tenda CP3 cameras reboot and momentarily associate before reading
-- their factory EFUSE MAC. Historical rolled-up bytes are merged into the canonical
-- camera MAC sharing the same LAN IP so zero network traffic history is lost.

CREATE TABLE IF NOT EXISTS device_enrichment (
  mac          TEXT PRIMARY KEY,
  vendor       TEXT,
  device_type  TEXT,
  os_guess     TEXT,
  reverse_dns  TEXT,
  fingerprint  TEXT,
  last_check   INTEGER NOT NULL,
  next_check   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0
);

-- Ensure canonical Tenda camera OUIs have accurate vendor & category metadata.
UPDATE devices
SET vendor = 'Tenda',
    category = 'camera'
WHERE (mac LIKE '50:0F:F5:%' OR mac LIKE 'B4:0F:3B:%')
  AND (vendor IS NULL OR vendor = 'Unknown')
  AND (category IS NULL OR category IN ('unknown', 'router'));

-- Map each 88:00:33:77:* phantom MAC to the canonical non-88:00:33:77:* device
-- observed most recently on the same IPv4 address.
CREATE TEMP TABLE IF NOT EXISTS _aic8800_phantom_map AS
WITH phantom_ips AS (
  SELECT d.mac AS phantom_mac,
         (
           SELECT s.ip
           FROM samples_raw s
           WHERE s.mac = d.mac AND s.ip IS NOT NULL AND s.ip != ''
           ORDER BY s.ts DESC
           LIMIT 1
         ) AS ip
  FROM devices d
  WHERE d.mac LIKE '88:00:33:77:%'
),
canonical_ips AS (
  SELECT d.mac AS canonical_mac,
         d.last_seen,
         COALESCE(
           (SELECT r.ip FROM dhcp_reservations r WHERE r.mac = d.mac LIMIT 1),
           (SELECT s.ip FROM samples_raw s WHERE s.mac = d.mac AND s.ip IS NOT NULL AND s.ip != '' ORDER BY s.ts DESC LIMIT 1)
         ) AS ip
  FROM devices d
  WHERE d.mac NOT LIKE '88:00:33:77:%'
)
SELECT p.phantom_mac,
       (
         SELECT c.canonical_mac
         FROM canonical_ips c
         WHERE c.ip = p.ip
         ORDER BY c.last_seen DESC
         LIMIT 1
       ) AS canonical_mac
FROM phantom_ips p
WHERE p.ip IS NOT NULL;

DELETE FROM _aic8800_phantom_map WHERE canonical_mac IS NULL;

-- Merge 5-minute traffic buckets into canonical camera MACs.
INSERT INTO traffic_5min (mac, bucket_ts, bytes_down, bytes_up, avg_down_bps, avg_up_bps, peak_down_bps, peak_up_bps, active_sec, sample_count)
SELECT m.canonical_mac,
       t.bucket_ts,
       SUM(t.bytes_down),
       SUM(t.bytes_up),
       MAX(COALESCE(t.avg_down_bps, 0)),
       MAX(COALESCE(t.avg_up_bps, 0)),
       MAX(COALESCE(t.peak_down_bps, 0)),
       MAX(COALESCE(t.peak_up_bps, 0)),
       SUM(t.active_sec),
       SUM(t.sample_count)
FROM traffic_5min t
JOIN _aic8800_phantom_map m ON m.phantom_mac = t.mac
GROUP BY m.canonical_mac, t.bucket_ts
ON CONFLICT(mac, bucket_ts) DO UPDATE SET
  bytes_down    = traffic_5min.bytes_down + excluded.bytes_down,
  bytes_up      = traffic_5min.bytes_up + excluded.bytes_up,
  peak_down_bps = MAX(COALESCE(traffic_5min.peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
  peak_up_bps   = MAX(COALESCE(traffic_5min.peak_up_bps, 0), COALESCE(excluded.peak_up_bps, 0)),
  active_sec    = traffic_5min.active_sec + excluded.active_sec,
  sample_count  = traffic_5min.sample_count + excluded.sample_count;

-- Merge hourly traffic buckets.
INSERT INTO traffic_hour (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
SELECT m.canonical_mac,
       t.bucket_ts,
       SUM(t.bytes_down),
       SUM(t.bytes_up),
       SUM(t.active_sec),
       MAX(COALESCE(t.peak_down_bps, 0)),
       MAX(COALESCE(t.peak_up_bps, 0))
FROM traffic_hour t
JOIN _aic8800_phantom_map m ON m.phantom_mac = t.mac
GROUP BY m.canonical_mac, t.bucket_ts
ON CONFLICT(mac, bucket_ts) DO UPDATE SET
  bytes_down    = traffic_hour.bytes_down + excluded.bytes_down,
  bytes_up      = traffic_hour.bytes_up + excluded.bytes_up,
  active_sec    = traffic_hour.active_sec + excluded.active_sec,
  peak_down_bps = MAX(COALESCE(traffic_hour.peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
  peak_up_bps   = MAX(COALESCE(traffic_hour.peak_up_bps, 0), COALESCE(excluded.peak_up_bps, 0));

-- Merge daily traffic buckets.
INSERT INTO traffic_day (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
SELECT m.canonical_mac,
       t.bucket_ts,
       SUM(t.bytes_down),
       SUM(t.bytes_up),
       SUM(t.active_sec),
       MAX(COALESCE(t.peak_down_bps, 0)),
       MAX(COALESCE(t.peak_up_bps, 0))
FROM traffic_day t
JOIN _aic8800_phantom_map m ON m.phantom_mac = t.mac
GROUP BY m.canonical_mac, t.bucket_ts
ON CONFLICT(mac, bucket_ts) DO UPDATE SET
  bytes_down    = traffic_day.bytes_down + excluded.bytes_down,
  bytes_up      = traffic_day.bytes_up + excluded.bytes_up,
  active_sec    = traffic_day.active_sec + excluded.active_sec,
  peak_down_bps = MAX(COALESCE(traffic_day.peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
  peak_up_bps   = MAX(COALESCE(traffic_day.peak_up_bps, 0), COALESCE(excluded.peak_up_bps, 0));

-- Merge monthly traffic buckets.
INSERT INTO traffic_month (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
SELECT m.canonical_mac,
       t.bucket_ts,
       SUM(t.bytes_down),
       SUM(t.bytes_up),
       SUM(t.active_sec),
       MAX(COALESCE(t.peak_down_bps, 0)),
       MAX(COALESCE(t.peak_up_bps, 0))
FROM traffic_month t
JOIN _aic8800_phantom_map m ON m.phantom_mac = t.mac
GROUP BY m.canonical_mac, t.bucket_ts
ON CONFLICT(mac, bucket_ts) DO UPDATE SET
  bytes_down    = traffic_month.bytes_down + excluded.bytes_down,
  bytes_up      = traffic_month.bytes_up + excluded.bytes_up,
  active_sec    = traffic_month.active_sec + excluded.active_sec,
  peak_down_bps = MAX(COALESCE(traffic_month.peak_down_bps, 0), COALESCE(excluded.peak_down_bps, 0)),
  peak_up_bps   = MAX(COALESCE(traffic_month.peak_up_bps, 0), COALESCE(excluded.peak_up_bps, 0));

DROP TABLE IF EXISTS _aic8800_phantom_map;

-- Purge all phantom 88:00:33:77:* rows and alerts.
DELETE FROM alerts WHERE mac LIKE '88:00:33:77:%';
DELETE FROM samples_raw WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_5min WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_hour WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_day WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_month WHERE mac LIKE '88:00:33:77:%';
DELETE FROM device_sessions WHERE mac LIKE '88:00:33:77:%';
DELETE FROM device_enrichment WHERE mac LIKE '88:00:33:77:%';
DELETE FROM devices WHERE mac LIKE '88:00:33:77:%';
