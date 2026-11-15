-- 024_auto_dhcp_reservation.sql
-- Track automatic DHCP Address Reservation state alongside automatic SD QoS capping for new devices.

ALTER TABLE device_auto_qos ADD COLUMN reserve_state TEXT NOT NULL DEFAULT 'skipped';
ALTER TABLE device_auto_qos ADD COLUMN reserved_ip TEXT;
ALTER TABLE device_auto_qos ADD COLUMN reserve_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_auto_qos ADD COLUMN reserve_error TEXT;
