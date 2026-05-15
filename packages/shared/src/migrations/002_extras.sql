-- Optional per-device monthly/daily quota (user-set bandwidth cap)
CREATE TABLE IF NOT EXISTS device_quotas (
  mac           TEXT PRIMARY KEY,
  daily_bytes   INTEGER,
  monthly_bytes INTEGER,
  notify_at_pct INTEGER NOT NULL DEFAULT 80,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- User-defined alert rules (extensible)
CREATE TABLE IF NOT EXISTS alert_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- 'speed_threshold' | 'quota' | 'new_device' | 'security'
  config       TEXT NOT NULL,             -- JSON
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- Optional online/offline session log (computed from samples_raw transitions)
CREATE TABLE IF NOT EXISTS device_sessions (
  mac          TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  bytes_down   INTEGER DEFAULT 0,
  bytes_up     INTEGER DEFAULT 0,
  PRIMARY KEY (mac, started_at)
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON device_sessions(started_at);
