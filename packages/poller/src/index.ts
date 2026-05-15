import { loadConfig, getDb, runMigrations } from '@tenda/shared';
import path from 'node:path';
import fs from 'node:fs';
import { RouterClient } from './router-client.js';
import { Sampler } from './sampler.js';
import { IpcBroadcaster } from './ipc.js';
import { startControlServer } from './control-server.js';
import { SyslogServer } from './syslog-server.js';
import { TelegramNotifier } from './telegram-notifier.js';
import { log } from './logger.js';

function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

async function main() {
  const cfg = loadConfig();
  runMigrations();
  const db = getDb();

  const router = new RouterClient(cfg.routerHost, cfg.routerPassword);
  const ipc = new IpcBroadcaster(cfg.ipcSocket);
  const sampler = new Sampler(db, router, ipc, cfg.pollIntervalMs);

  const controlPort = Number(process.env.CONTROL_PORT ?? 3031);
  const controlServer = startControlServer(controlPort, router, resolveRepoRoot(), sampler);

  const syslogPort = Number(process.env.SYSLOG_PORT ?? 514);
  const syslog = new SyslogServer(db, syslogPort);
  syslog.start();

  const tg = new TelegramNotifier(db);
  const tgTimer = setInterval(() => { tg.tick().catch((e) => log.warn('tg.tick error', String(e))); }, 60_000);

  if (!cfg.routerPassword) {
    log.warn('ROUTER_PASSWORD not set — control server ready for onboarding, sampler idle until credentials saved');
  } else {
    log.info('poller starting', { host: cfg.routerHost, intervalMs: cfg.pollIntervalMs, db: cfg.dbPath, controlPort, syslogPort });
    sampler.start();
  }

  // Watch for credentials becoming available via control-server -> .env update
  // RouterClient.setCredentials updates host/password live; we just need to (re)start the sampler.
  const credentialWatcher = setInterval(() => {
    const havePwd = (process.env.ROUTER_PASSWORD ?? '').trim().length > 0;
    if (havePwd && !sampler.isRunning()) {
      log.info('credentials available — starting sampler');
      sampler.start();
    }
  }, 3000);

  const shutdown = (sig: string) => {
    log.info('shutting down', { sig });
    sampler.stop();
    ipc.close();
    controlServer.close();
    syslog.stop();
    clearInterval(tgTimer);
    clearInterval(credentialWatcher);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => log.error('uncaught', String(e)));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', String(e)));
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
