-- Track per-WAN Cloudflare DNS-Only (`proxied: false`, `ttl: 60`) DDNS sync state.
-- Credentials (`CF_API_TOKEN`, `CF_ZONE_ID`) live strictly in local `.env` and are never stored in SQLite.

ALTER TABLE router_wan_ports ADD COLUMN ddns_fqdn TEXT;
ALTER TABLE router_wan_ports ADD COLUMN ddns_synced_ip TEXT;
ALTER TABLE router_wan_ports ADD COLUMN ddns_synced_at INTEGER;
ALTER TABLE router_wan_ports ADD COLUMN ddns_last_error TEXT;
