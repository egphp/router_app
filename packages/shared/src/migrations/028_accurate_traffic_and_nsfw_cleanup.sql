-- Migration 028:
-- 1. Purge false-positive non-adult AI domain hits (e.g. IPTV/HLS .xyz CDN edge domains classified as malware_phishing)
--    from nsfw_hits, nsfw_push_events, and alerts; cache known IPTV CDN domains as safe.
-- 2. Classify local IP cameras & Hall Wi-Fi repeater radios (including 66:62:8B:B3:9F:53 2.4GHz camera bridge MAC)
--    so local camera/repeater traffic is cleanly excluded from user internet consumption totals.
-- 3. Rebuild traffic_day and traffic_month cleanly from canonical traffic_hour using DST-safe local calendar midnight
--    (eliminating the 2x duplicate rows created across the Egypt UTC+3 -> UTC+2 DST transition), and merge split wan_traffic_day rows.

DELETE FROM nsfw_hits
WHERE category LIKE 'ai-malware%'
   OR category LIKE 'ai-gambling%'
   OR category LIKE 'ai-vpn%'
   OR category LIKE 'ai-iot%';

DELETE FROM nsfw_push_events
WHERE category LIKE 'ai-malware%'
   OR category LIKE 'ai-gambling%'
   OR category LIKE 'ai-vpn%'
   OR category LIKE 'ai-iot%';

DELETE FROM alerts
WHERE kind = 'nsfw'
  AND (
    json_extract(payload, '$.category') LIKE 'ai-malware%'
    OR json_extract(payload, '$.category') LIKE 'ai-gambling%'
    OR json_extract(payload, '$.rule') = 'suspicious_domain_visit'
  );

UPDATE ai_domain_cache
SET category = 'safe', confidence = 0.99, source = 'iptv-cdn-verified'
WHERE domain IN (
  'bbcukjournal.xyz',
  'testyourowncv.xyz',
  'datalowoffwordpress.xyz',
  'buildyourowncv.xyz',
  'runyourowncv.xyz'
);

-- Classify known local cameras and repeater bridge MACs accurately
UPDATE devices
SET category = 'router',
    custom_label = CASE
      WHEN mac = '66:62:8B:B3:9F:53' AND (custom_label IS NULL OR custom_label = 'Redmi 10 2022')
      THEN 'ربيتر الصالة (2.4GHz / كاميرات)'
      ELSE custom_label
    END
WHERE mac IN ('66:62:8B:B3:9F:52', '66:62:8B:B3:9F:53');

UPDATE devices
SET category = 'camera',
    vendor = CASE WHEN vendor IS NULL OR vendor = 'Unknown' THEN 'Hikvision' ELSE vendor END
WHERE mac IN ('E0:CA:3C:67:03:A8', '98:8B:0A:7A:9B:28');

UPDATE devices
SET category = 'camera'
WHERE mac IN ('50:0F:F5:B2:F2:D0', '50:0F:F5:B2:FF:E2', 'B4:0F:3B:9A:F5:98', 'B4:0F:3B:22:BC:42');

-- Rebuild traffic_day idempotently from canonical traffic_hour using true DST-aware local midnight
DELETE FROM traffic_day
WHERE EXISTS (SELECT 1 FROM traffic_hour LIMIT 1)
  AND bucket_ts < CAST(strftime('%s', datetime('now', 'localtime', 'start of day'), 'utc') AS INTEGER) * 1000;

INSERT OR REPLACE INTO traffic_day (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
SELECT
  mac,
  CAST(strftime('%s', datetime(bucket_ts / 1000, 'unixepoch', 'localtime', 'start of day'), 'utc') AS INTEGER) * 1000 AS day_bucket_ts,
  SUM(bytes_down) AS bytes_down,
  SUM(bytes_up) AS bytes_up,
  SUM(active_sec) AS active_sec,
  MAX(COALESCE(peak_down_bps, 0)) AS peak_down_bps,
  MAX(COALESCE(peak_up_bps, 0)) AS peak_up_bps
FROM traffic_hour
WHERE bucket_ts < CAST(strftime('%s', datetime('now', 'localtime', 'start of day'), 'utc') AS INTEGER) * 1000
GROUP BY mac, day_bucket_ts;

-- Rebuild traffic_month idempotently from the clean traffic_day rows
DELETE FROM traffic_month
WHERE EXISTS (SELECT 1 FROM traffic_day LIMIT 1)
  AND bucket_ts < CAST(strftime('%s', datetime('now', 'localtime', 'start of month'), 'utc') AS INTEGER) * 1000;

INSERT OR REPLACE INTO traffic_month (mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
SELECT
  mac,
  CAST(strftime('%s', datetime(bucket_ts / 1000, 'unixepoch', 'localtime', 'start of month'), 'utc') AS INTEGER) * 1000 AS month_bucket_ts,
  SUM(bytes_down) AS bytes_down,
  SUM(bytes_up) AS bytes_up,
  SUM(active_sec) AS active_sec,
  MAX(COALESCE(peak_down_bps, 0)) AS peak_down_bps,
  MAX(COALESCE(peak_up_bps, 0)) AS peak_up_bps
FROM traffic_day
WHERE bucket_ts < CAST(strftime('%s', datetime('now', 'localtime', 'start of month'), 'utc') AS INTEGER) * 1000
GROUP BY mac, month_bucket_ts;

-- Merge any DST-split rows in wan_traffic_day onto true local calendar midnight
CREATE TEMP TABLE _wan_day_clean AS
SELECT
  CAST(strftime('%s', datetime(bucket_ts / 1000, 'unixepoch', 'localtime', 'start of day'), 'utc') AS INTEGER) * 1000 AS day_bucket_ts,
  SUM(bytes_up) AS bytes_up,
  SUM(bytes_down) AS bytes_down
FROM wan_traffic_day
GROUP BY day_bucket_ts;

DELETE FROM wan_traffic_day;
INSERT INTO wan_traffic_day (bucket_ts, bytes_up, bytes_down)
SELECT day_bucket_ts, bytes_up, bytes_down FROM _wan_day_clean;
DROP TABLE _wan_day_clean;
