-- Per-installation settings persisted across restarts.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- NSFW URL detection log. Populated by the poller when it parses syslog/URL
-- entries against a built-in NSFW domain list.
CREATE TABLE IF NOT EXISTS nsfw_hits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  source_mac    TEXT,
  source_ip     TEXT,
  domain        TEXT NOT NULL,
  category      TEXT NOT NULL,
  raw_excerpt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_nsfw_hits_ts  ON nsfw_hits(ts);
CREATE INDEX IF NOT EXISTS idx_nsfw_hits_mac ON nsfw_hits(source_mac);
