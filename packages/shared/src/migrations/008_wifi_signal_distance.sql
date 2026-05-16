ALTER TABLE samples_raw ADD COLUMN connect_type INTEGER;
ALTER TABLE samples_raw ADD COLUMN connection_kind TEXT;
ALTER TABLE samples_raw ADD COLUMN wifi_band TEXT;
ALTER TABLE samples_raw ADD COLUMN wifi_rssi_dbm REAL;
ALTER TABLE samples_raw ADD COLUMN wifi_signal_percent REAL;
ALTER TABLE samples_raw ADD COLUMN wifi_distance_m REAL;
ALTER TABLE samples_raw ADD COLUMN wifi_distance_source TEXT;

CREATE INDEX IF NOT EXISTS idx_samples_wifi_distance ON samples_raw(wifi_distance_m) WHERE wifi_distance_m IS NOT NULL;
