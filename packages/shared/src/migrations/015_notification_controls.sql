CREATE TABLE IF NOT EXISTS notification_suppressions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  suppression_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  rule            TEXT,
  mac             TEXT,
  label           TEXT,
  source_alert_id INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_suppressions_kind ON notification_suppressions(kind);
CREATE INDEX IF NOT EXISTS idx_notification_suppressions_mac ON notification_suppressions(mac);

CREATE TABLE IF NOT EXISTS notification_state (
  state_key         TEXT PRIMARY KEY,
  last_triggered_at INTEGER NOT NULL,
  value             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_notification_thresholds (
  mac                  TEXT PRIMARY KEY,
  enabled              INTEGER NOT NULL DEFAULT 1,
  download_limit_bytes INTEGER NOT NULL DEFAULT 0,
  period               TEXT NOT NULL DEFAULT 'today',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('notification_enabled_new_device', 'on'),
  ('notification_enabled_nsfw', 'on'),
  ('notification_enabled_security', 'on'),
  ('notification_enabled_attack', 'on'),
  ('notification_enabled_outage', 'on'),
  ('notification_enabled_reboot', 'on'),
  ('notification_enabled_total_download_threshold', 'on'),
  ('notification_enabled_device_download_threshold', 'on'),
  ('notification_enabled_test', 'on'),
  ('notification_total_download_enabled', 'off'),
  ('notification_total_download_limit_bytes', '0'),
  ('notification_total_download_period', 'today'),
  ('notification_device_download_enabled', 'off'),
  ('notification_device_download_default_limit_bytes', '0'),
  ('notification_device_download_default_period', 'today');
