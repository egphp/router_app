CREATE TABLE IF NOT EXISTS router_syslog (
  router_id    INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  log_type     INTEGER NOT NULL,
  message      TEXT NOT NULL,
  attacker_ip  TEXT,
  attacker_mac TEXT,
  attack_kind  TEXT,
  attack_count INTEGER,
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (router_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_router_syslog_ts ON router_syslog(ts);
CREATE INDEX IF NOT EXISTS idx_router_syslog_type ON router_syslog(log_type);
CREATE INDEX IF NOT EXISTS idx_router_syslog_mac ON router_syslog(attacker_mac);
