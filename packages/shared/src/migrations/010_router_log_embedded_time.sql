CREATE TABLE IF NOT EXISTS router_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  priority    INTEGER,
  facility    INTEGER,
  severity    INTEGER,
  host        TEXT,
  tag         TEXT,
  message     TEXT NOT NULL,
  src_ip      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_log_ts ON router_log(ts);

UPDATE router_log
SET ts = CAST(unixepoch(substr(message, instr(message, 'time:') + 5, 19), 'utc') AS INTEGER) * 1000
WHERE instr(message, 'time:') > 0
  AND substr(message, instr(message, 'time:') + 5, 19) GLOB '????-??-?? ??:??:??'
  AND unixepoch(substr(message, instr(message, 'time:') + 5, 19), 'utc') IS NOT NULL;
