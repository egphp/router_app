CREATE TABLE IF NOT EXISTS remote_login_attempts (
  scope           TEXT PRIMARY KEY,
  failures        INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until    INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint          TEXT NOT NULL UNIQUE,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  expiration_time   INTEGER,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_success_at   INTEGER,
  last_failure_at   INTEGER,
  last_error        TEXT,
  client_platform   TEXT,
  client_user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_status ON push_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated ON push_subscriptions(updated_at);

CREATE TABLE IF NOT EXISTS push_delivery_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_hash   TEXT NOT NULL,
  tag             TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_delivery_log_created ON push_delivery_log(created_at);
