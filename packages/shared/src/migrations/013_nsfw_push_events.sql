CREATE TABLE IF NOT EXISTS nsfw_push_events (
  event_key   TEXT PRIMARY KEY,
  source_mac  TEXT,
  source_ip   TEXT,
  domain      TEXT NOT NULL,
  category    TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nsfw_push_events_seen ON nsfw_push_events(first_seen);
