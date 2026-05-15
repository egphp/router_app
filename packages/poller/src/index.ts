import { loadConfig, getDb, runMigrations } from '@tenda/shared';
import path from 'node:path';
import fs from 'node:fs';
import { RouterClient } from './router-client.js';
import { Sampler } from './sampler.js';
import { IpcBroadcaster } from './ipc.js';
import { startControlServer } from './control-server.js';
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
  if (!cfg.routerPassword) {
    log.error('ROUTER_PASSWORD not set; refusing to start');
    process.exit(1);
  }
  runMigrations();
  const db = getDb();

  const router = new RouterClient(cfg.routerHost, cfg.routerPassword);
  const ipc = new IpcBroadcaster(cfg.ipcSocket);
  const sampler = new Sampler(db, router, ipc, cfg.pollIntervalMs);

  const controlPort = Number(process.env.CONTROL_PORT ?? 3031);
  const controlServer = startControlServer(controlPort, router, resolveRepoRoot());

  log.info('poller starting', { host: cfg.routerHost, intervalMs: cfg.pollIntervalMs, db: cfg.dbPath, controlPort });
  sampler.start();

  const shutdown = (sig: string) => {
    log.info('shutting down', { sig });
    sampler.stop();
    ipc.close();
    controlServer.close();
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
