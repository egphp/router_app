import { loadConfig, getDb, runMigrations } from '@tenda/shared';
import { RouterClient } from './router-client.js';
import { Sampler } from './sampler.js';
import { IpcBroadcaster } from './ipc.js';
import { log } from './logger.js';

async function main() {
  const cfg = loadConfig();
  if (!cfg.routerPassword) {
    log.error('ROUTER_PASSWORD not set; refusing to start');
    process.exit(1);
  }
  runMigrations();
  const db = getDb();

  const router = new RouterClient(cfg.routerHost, cfg.routerPassword);
  const ipc = new IpcBroadcaster(cfg.ipcSocket);
  const sampler = new Sampler(db, router, ipc, cfg.pollIntervalMs);

  log.info('poller starting', { host: cfg.routerHost, intervalMs: cfg.pollIntervalMs, db: cfg.dbPath });
  sampler.start();

  const shutdown = (sig: string) => {
    log.info('shutting down', { sig });
    sampler.stop();
    ipc.close();
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
