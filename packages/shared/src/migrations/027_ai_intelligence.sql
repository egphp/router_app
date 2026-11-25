-- Gemini AI Intelligence & Caching Layer (Router-Only Telemetry + Zero-PII Safe)

CREATE TABLE IF NOT EXISTS ai_domain_cache (
  domain      TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL DEFAULT 'gemini-decision-1',
  checked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_domain_cache_cat ON ai_domain_cache(category);

CREATE TABLE IF NOT EXISTS ai_device_profiles (
  mac                     TEXT PRIMARY KEY REFERENCES devices(mac) ON DELETE CASCADE,
  suggested_label         TEXT,
  inferred_category       TEXT,
  os_guess                TEXT,
  trust_tier              TEXT NOT NULL DEFAULT 'unknown',
  recommended_qos_profile TEXT NOT NULL DEFAULT 'sd',
  recommended_down_kbs    INTEGER NOT NULL DEFAULT 256,
  recommended_up_kbs      INTEGER NOT NULL DEFAULT 64,
  recommended_wan         INTEGER,
  trust_confidence        REAL NOT NULL DEFAULT 0,
  randomized_match_mac    TEXT REFERENCES devices(mac) ON DELETE SET NULL,
  randomized_similarity   REAL,
  rationale_ar            TEXT,
  behavior_vector_json    TEXT,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_device_profiles_match ON ai_device_profiles(randomized_match_mac);

CREATE TABLE IF NOT EXISTS ai_insights (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type              TEXT NOT NULL,
  scope_key               TEXT NOT NULL,
  verdict                 TEXT NOT NULL DEFAULT 'info',
  lan_or_wan              TEXT,
  title_ar                TEXT NOT NULL,
  explanation_ar          TEXT NOT NULL,
  recommended_action_json TEXT,
  model_used              TEXT NOT NULL,
  created_at              INTEGER NOT NULL,
  UNIQUE(scope_type, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_insights_scope ON ai_insights(scope_type, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_qos_schedules (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  natural_prompt       TEXT,
  days_mask            TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  start_hhmm           TEXT NOT NULL,
  end_hhmm             TEXT NOT NULL,
  target_selector_json TEXT NOT NULL,
  download_limit_kbs   INTEGER NOT NULL DEFAULT 0,
  upload_limit_kbs     INTEGER NOT NULL DEFAULT 0,
  wan_port             INTEGER,
  enabled              INTEGER NOT NULL DEFAULT 1,
  last_applied_state   TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_syslog_clusters (
  cluster_key    TEXT PRIMARY KEY,
  sample_message TEXT NOT NULL,
  summary_ar     TEXT,
  severity       TEXT NOT NULL DEFAULT 'info',
  line_count     INTEGER NOT NULL DEFAULT 1,
  embedding_json TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_syslog_clusters_seen ON ai_syslog_clusters(last_seen DESC);
