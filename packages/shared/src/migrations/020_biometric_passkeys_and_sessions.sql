-- Biometric-only WebAuthn Passkeys, single-use challenges, one-time enrollment tokens,
-- revocable server-side sessions, and auth security audit log.

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id                  TEXT PRIMARY KEY,
  public_key          BLOB NOT NULL,
  counter             INTEGER NOT NULL DEFAULT 0,
  rp_id               TEXT NOT NULL,
  origin              TEXT NOT NULL,
  transports          TEXT,
  device_type         TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up           INTEGER NOT NULL DEFAULT 0,
  aaguid              TEXT,
  label               TEXT NOT NULL,
  user_agent          TEXT,
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  revoked_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_rpid ON passkey_credentials(rp_id, revoked_at);

CREATE TABLE IF NOT EXISTS passkey_enrollment_tokens (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash          TEXT NOT NULL UNIQUE,
  label_hint          TEXT,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  used_at             INTEGER,
  used_credential_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_enroll_expires ON passkey_enrollment_tokens(expires_at, used_at);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_id        TEXT PRIMARY KEY,
  challenge           TEXT NOT NULL UNIQUE,
  purpose             TEXT NOT NULL,
  rp_id               TEXT NOT NULL,
  expected_origin     TEXT NOT NULL,
  enrollment_id       INTEGER REFERENCES passkey_enrollment_tokens(id) ON DELETE CASCADE,
  label_hint          TEXT,
  ip_hash             TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS panel_sessions (
  session_id_hash     TEXT PRIMARY KEY,
  credential_id       TEXT NOT NULL REFERENCES passkey_credentials(id) ON DELETE CASCADE,
  rp_id               TEXT NOT NULL,
  ua_hash             TEXT NOT NULL,
  ip_hash             TEXT,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_panel_sessions_credential ON panel_sessions(credential_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_panel_sessions_expires ON panel_sessions(expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS auth_security_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type          TEXT NOT NULL,
  rp_id               TEXT,
  credential_id       TEXT,
  ip_hash             TEXT,
  detail              TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_security_events_created ON auth_security_events(created_at DESC);
