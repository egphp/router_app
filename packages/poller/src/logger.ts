import { loadConfig } from '@tenda/shared';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const cfg = loadConfig();
const min = LEVELS[cfg.logLevel];

function fmt(level: Level, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  if (extra === undefined) return base;
  try {
    return `${base} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  } catch {
    return base;
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => LEVELS.debug >= min && console.log(fmt('debug', msg, extra)),
  info:  (msg: string, extra?: unknown) => LEVELS.info  >= min && console.log(fmt('info',  msg, extra)),
  warn:  (msg: string, extra?: unknown) => LEVELS.warn  >= min && console.warn(fmt('warn',  msg, extra)),
  error: (msg: string, extra?: unknown) => LEVELS.error >= min && console.error(fmt('error', msg, extra)),
};
