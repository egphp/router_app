-- Cache the router's Address Reservation table locally so the web UI can show
-- "reserved" badges without having to round-trip to the router on every render,
-- and so the security scanner can silence random_mac_device findings for any
-- MAC the user has explicitly bound.
--
-- The poller refreshes this table every ~60s from getDhcpClientList. Rows are
-- replaced wholesale on each refresh (we don't try to track history).

CREATE TABLE IF NOT EXISTS dhcp_reservations (
  mac          TEXT PRIMARY KEY,
  ip           TEXT NOT NULL,
  hostname     TEXT,
  router_id    INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_ip ON dhcp_reservations(ip);

-- Dismiss any random_mac_device findings whose MAC the user has already
-- reserved at the router. The new scanner won't re-fire for reserved MACs.
-- (At migration time the table is still empty, so this is a no-op the first
-- time it runs — the scanner will populate then re-run on the next cycle.)
UPDATE alerts
SET dismissed_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE kind = 'security'
  AND dismissed_at IS NULL
  AND json_extract(payload, '$.rule') = 'random_mac_device'
  AND mac IN (SELECT mac FROM dhcp_reservations);
