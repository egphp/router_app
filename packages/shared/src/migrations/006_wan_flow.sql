-- WAN-level traffic samples + cumulative ground truth, separate from per-device estimates.
-- The Tenda W30E firmware does not expose hostUploadSum per device, so per-device upload
-- is estimated from instantaneous speeds. WAN-level flux is reported directly by the
-- router as "1.16KB/s" etc. and integrated over time here for an authoritative total.

CREATE TABLE IF NOT EXISTS wan_samples (
  ts            INTEGER NOT NULL,
  wan_id        INTEGER NOT NULL,
  up_bytes_per_s INTEGER NOT NULL,
  down_bytes_per_s INTEGER NOT NULL,
  PRIMARY KEY (ts, wan_id)
);
CREATE INDEX IF NOT EXISTS idx_wan_samples_ts ON wan_samples(ts);

CREATE TABLE IF NOT EXISTS wan_traffic_5min (
  bucket_ts    INTEGER PRIMARY KEY,
  bytes_up     INTEGER NOT NULL DEFAULT 0,
  bytes_down   INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wan_traffic_day (
  bucket_ts    INTEGER PRIMARY KEY,
  bytes_up     INTEGER NOT NULL DEFAULT 0,
  bytes_down   INTEGER NOT NULL DEFAULT 0
);
