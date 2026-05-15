-- Per-device enrichment cache. Populated by the poller's background queue.
CREATE TABLE IF NOT EXISTS device_enrichment (
  mac          TEXT PRIMARY KEY,
  vendor       TEXT,                  -- OUI lookup
  device_type  TEXT,                  -- phone, laptop, iot, etc. (inferred)
  os_guess     TEXT,                  -- inferred from hostname / DHCP options
  reverse_dns  TEXT,                  -- mDNS / DNS PTR
  fingerprint  TEXT,                  -- JSON of heuristic signals
  last_check   INTEGER NOT NULL,
  next_check   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dev_enrich_next ON device_enrichment(next_check);
