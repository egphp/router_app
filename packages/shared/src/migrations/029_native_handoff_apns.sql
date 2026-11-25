-- One-time codes that move an already verified passkey session into the native app,
-- and Apple push tokens registered by that same session.

CREATE TABLE IF NOT EXISTS native_handoff_codes (
  code_hash     TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  rp_id         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_native_handoff_expires ON native_handoff_codes(expires_at);

CREATE TABLE IF NOT EXISTS apns_devices (
  token_hash     TEXT PRIMARY KEY,
  token          TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  bundle_id      TEXT NOT NULL,
  environment    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  disabled_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apns_devices_active ON apns_devices(disabled_at, credential_id);
