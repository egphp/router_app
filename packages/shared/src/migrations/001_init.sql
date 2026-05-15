PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS devices (
  mac           TEXT PRIMARY KEY,
  router_id     INTEGER,
  hostname      TEXT,
  router_remark TEXT,
  custom_label  TEXT,
  vendor        TEXT,
  category      TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  is_new        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS samples_raw (
  mac            TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  ip             TEXT,
  online         INTEGER NOT NULL,
  up_speed_bps   INTEGER NOT NULL,
  down_speed_bps INTEGER NOT NULL,
  down_sum_kb    INTEGER NOT NULL,
  sessions       INTEGER,
  online_seconds INTEGER,
  PRIMARY KEY (mac, ts)
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples_raw(ts);

CREATE TABLE IF NOT EXISTS traffic_5min (
  mac            TEXT NOT NULL,
  bucket_ts      INTEGER NOT NULL,
  bytes_down     INTEGER NOT NULL DEFAULT 0,
  bytes_up       INTEGER NOT NULL DEFAULT 0,
  avg_down_bps   INTEGER,
  avg_up_bps     INTEGER,
  peak_down_bps  INTEGER,
  peak_up_bps    INTEGER,
  active_sec     INTEGER NOT NULL DEFAULT 0,
  sample_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mac, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_t5_bucket ON traffic_5min(bucket_ts);

CREATE TABLE IF NOT EXISTS traffic_hour (
  mac          TEXT NOT NULL,
  bucket_ts    INTEGER NOT NULL,
  bytes_down   INTEGER NOT NULL DEFAULT 0,
  bytes_up     INTEGER NOT NULL DEFAULT 0,
  active_sec   INTEGER NOT NULL DEFAULT 0,
  peak_down_bps INTEGER,
  peak_up_bps  INTEGER,
  PRIMARY KEY (mac, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_thour_bucket ON traffic_hour(bucket_ts);

CREATE TABLE IF NOT EXISTS traffic_day (
  mac          TEXT NOT NULL,
  bucket_ts    INTEGER NOT NULL,
  bytes_down   INTEGER NOT NULL DEFAULT 0,
  bytes_up     INTEGER NOT NULL DEFAULT 0,
  active_sec   INTEGER NOT NULL DEFAULT 0,
  peak_down_bps INTEGER,
  peak_up_bps  INTEGER,
  PRIMARY KEY (mac, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_tday_bucket ON traffic_day(bucket_ts);

CREATE TABLE IF NOT EXISTS traffic_month (
  mac          TEXT NOT NULL,
  bucket_ts    INTEGER NOT NULL,
  bytes_down   INTEGER NOT NULL DEFAULT 0,
  bytes_up     INTEGER NOT NULL DEFAULT 0,
  active_sec   INTEGER NOT NULL DEFAULT 0,
  peak_down_bps INTEGER,
  peak_up_bps  INTEGER,
  PRIMARY KEY (mac, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_tmonth_bucket ON traffic_month(bucket_ts);

CREATE TABLE IF NOT EXISTS router_state (
  ts           INTEGER PRIMARY KEY,
  uptime_sec   INTEGER NOT NULL,
  is_reboot    INTEGER NOT NULL DEFAULT 0,
  online_count INTEGER
);

CREATE TABLE IF NOT EXISTS outages (
  started_at  INTEGER PRIMARY KEY,
  ended_at    INTEGER,
  reason      TEXT NOT NULL,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  mac          TEXT,
  payload      TEXT,
  created_at   INTEGER NOT NULL,
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_undismissed ON alerts(dismissed_at) WHERE dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
