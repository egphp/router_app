CREATE INDEX IF NOT EXISTS idx_samples_mac_online_ts ON samples_raw(mac, online, ts);
