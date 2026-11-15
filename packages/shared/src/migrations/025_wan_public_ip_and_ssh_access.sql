-- Persist per-WAN real ISP Public IPs (probed via /32 static routes across Dual-WAN)
-- and cache Tenda W30E TCP Port Mapping rules (`getPortMapping` / `setPortMapping`).

ALTER TABLE router_wan_ports ADD COLUMN public_ip TEXT;
ALTER TABLE router_wan_ports ADD COLUMN public_ip_checked_at INTEGER;
ALTER TABLE router_wan_ports ADD COLUMN public_ip_changed_at INTEGER;

CREATE TABLE IF NOT EXISTS router_port_mappings (
  id            INTEGER PRIMARY KEY,
  wan_id        INTEGER NOT NULL,
  server_ip     TEXT NOT NULL,
  internal_port INTEGER NOT NULL,
  external_port INTEGER NOT NULL,
  protocol      INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_router_port_mappings_server
  ON router_port_mappings(server_ip, wan_id);
