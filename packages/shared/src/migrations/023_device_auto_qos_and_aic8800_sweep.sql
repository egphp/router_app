-- Ensure `device_auto_qos` exists on databases that applied `022` earlier,
-- and sweep any residual `88:00:33:77:%` NVRAM ghost rows inserted before poller restart.

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

DELETE FROM alerts WHERE mac LIKE '88:00:33:77:%';
DELETE FROM samples_raw WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_5min WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_hour WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_day WHERE mac LIKE '88:00:33:77:%';
DELETE FROM traffic_month WHERE mac LIKE '88:00:33:77:%';
DELETE FROM device_sessions WHERE mac LIKE '88:00:33:77:%';
DELETE FROM device_enrichment WHERE mac LIKE '88:00:33:77:%';
DELETE FROM router_qos_limits WHERE mac LIKE '88:00:33:77:%';
DELETE FROM device_auto_qos WHERE mac LIKE '88:00:33:77:%';
DELETE FROM devices WHERE mac LIKE '88:00:33:77:%';
