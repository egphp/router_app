-- The `many_random_macs` rule has been replaced by `random_mac_device`, which
-- emits one info-level finding per randomized-MAC device instead of a single
-- network-wide banner with only a count. Dismiss any old `many_random_macs`
-- alerts so they don't clutter the new alerts inbox; the scanner will fire
-- per-device findings instead, with full MAC/IP/hostname/vendor context.
--
-- History is preserved (rows are not deleted), just marked as dismissed.

UPDATE alerts
SET dismissed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE kind = 'security'
  AND dismissed_at IS NULL
  AND json_extract(payload, '$.rule') = 'many_random_macs';
