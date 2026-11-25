import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveRepoRoot(): string {
  for (const startDir of [process.cwd(), __dirname]) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

dotenv.config({ path: path.join(resolveRepoRoot(), '.env') });

export interface Config {
  routerHost: string;
  routerPassword: string;
  dbPath: string;
  pollIntervalMs: number;
  webPort: number;
  ipcSocket: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(): Config {
  const root = resolveRepoRoot();
  const dbPathRaw = process.env.DB_PATH ?? './tenda.db';
  const dbPath = path.isAbsolute(dbPathRaw) ? dbPathRaw : path.resolve(root, dbPathRaw);
  return {
    routerHost: process.env.ROUTER_HOST ?? '192.168.0.1',
    routerPassword: process.env.ROUTER_PASSWORD ?? '',
    dbPath,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 10000),
    webPort: Number(process.env.WEB_PORT ?? 3030),
    ipcSocket: process.env.IPC_SOCKET ?? '/tmp/tenda-monitor.sock',
    logLevel: (process.env.LOG_LEVEL ?? 'info') as Config['logLevel'],
  };
}
