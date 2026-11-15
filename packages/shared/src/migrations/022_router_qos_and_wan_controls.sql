-- Local SQLite caches for Tenda W30E per-device QoS bandwidth limits
-- (`getQosUserList` / `setQosUserList`), Multi-WAN policy routing
-- (`getWanInfo`, `getWanRoutePolicy`, `getWanRouteRules`, `getIPGroupList`),
-- and automatic SD quarantine speed caps for newly discovered devices.

CREATE TABLE IF NOT EXISTS router_qos_limits (
  mac                TEXT PRIMARY KEY,
  router_id          INTEGER NOT NULL,
  ip                 TEXT,
  router_remark      TEXT,
  online             INTEGER NOT NULL DEFAULT 0,
  download_limit_kbs INTEGER NOT NULL DEFAULT 0,
  upload_limit_kbs   INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_wan_ports (
  wan_id        INTEGER PRIMARY KEY,
  wan_name      TEXT NOT NULL,
  status        TEXT NOT NULL,
  wan_type      TEXT,
  wan_ip        TEXT,
  wan_gateway   TEXT,
  up_flux_bps   INTEGER NOT NULL DEFAULT 0,
  down_flux_bps INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_wan_bindings (
  ip                   TEXT PRIMARY KEY,
  wan_port             TEXT NOT NULL,
  rule_id              INTEGER NOT NULL,
  rule_enabled         INTEGER NOT NULL DEFAULT 1,
  ip_group_id          INTEGER,
  ip_group_name        TEXT NOT NULL,
  start_ip             TEXT NOT NULL,
  end_ip               TEXT NOT NULL,
  inherited_from_range INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_wan_bindings_port ON router_wan_bindings(wan_port);

CREATE TABLE IF NOT EXISTS device_auto_qos (
  mac              TEXT PRIMARY KEY,
  state            TEXT NOT NULL DEFAULT 'pending',
  target_down_kbs  INTEGER NOT NULL DEFAULT 256,
  target_up_kbs    INTEGER NOT NULL DEFAULT 64,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  applied_at       INTEGER,
  reviewed_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_auto_qos_state ON device_auto_qos(state);
