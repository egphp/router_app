import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..', '..');
}
export function loadConfig() {
    const root = resolveRepoRoot();
    const dbPathRaw = process.env.DB_PATH ?? './tenda.db';
    const dbPath = path.isAbsolute(dbPathRaw) ? dbPathRaw : path.resolve(root, dbPathRaw);
    return {
        routerHost: process.env.ROUTER_HOST ?? '192.168.0.1',
        routerPassword: process.env.ROUTER_PASSWORD ?? '',
        dbPath,
        pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30000),
        webPort: Number(process.env.WEB_PORT ?? 3030),
        ipcSocket: process.env.IPC_SOCKET ?? '/tmp/tenda-monitor.sock',
        logLevel: (process.env.LOG_LEVEL ?? 'info'),
    };
}
//# sourceMappingURL=config.js.map