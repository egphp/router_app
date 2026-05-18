-- Defensive re-heal after Pass 1 incorrectly treated `onlineTime` as seconds
-- (it's actually minutes). Any open session created while Pass 1 was active
-- has `started_at = now - onlineMinutes * 1000` instead of the correct
-- `now - onlineMinutes * 60_000`, leaving it pointing 60× too close to "now".
--
-- Strategy: if an open session's started_at is strictly newer than the
-- earliest samples_raw observation for that MAC, the started_at is implausible
-- (the device has been observed BEFORE the session is claimed to have begun).
-- Re-anchor to MIN(samples_raw.ts) for that MAC, unless that timestamp is
-- already taken by a closed session for the same MAC (PRIMARY KEY guard).
--
-- This is idempotent and a no-op on a healthy DB.

UPDATE device_sessions AS ds
SET started_at = COALESCE(
  (SELECT MIN(sr.ts) FROM samples_raw sr WHERE sr.mac = ds.mac),
  ds.started_at
)
WHERE ds.ended_at IS NULL
  AND EXISTS (SELECT 1 FROM samples_raw sr WHERE sr.mac = ds.mac)
  AND (SELECT MIN(sr.ts) FROM samples_raw sr WHERE sr.mac = ds.mac) < ds.started_at
  AND NOT EXISTS (
    SELECT 1 FROM device_sessions ds2
    WHERE ds2.mac = ds.mac
      AND ds2.started_at = (SELECT MIN(sr.ts) FROM samples_raw sr WHERE sr.mac = ds.mac)
      AND ds2.ended_at IS NOT NULL
  );
