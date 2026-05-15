import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

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

export async function GET() {
  const root = resolveRepoRoot();
  const adminMode = fs.existsSync(path.join(root, '.admin'));
  let local = '';
  let remote = '';
  let lastFetch: number | null = null;
  try {
    local = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf-8', timeout: 2000 }).trim();
    remote = execSync('git rev-parse --short origin/main', { cwd: root, encoding: 'utf-8', timeout: 2000 }).trim();
    // last fetch time from .git/FETCH_HEAD mtime
    try {
      const st = fs.statSync(path.join(root, '.git', 'FETCH_HEAD'));
      lastFetch = st.mtimeMs;
    } catch {}
  } catch {
    // not a git checkout or git missing
  }
  // Also expose the last successful auto-update log line
  let lastUpdate: string | null = null;
  try {
    const logPath = path.join(root, 'logs', 'auto-update.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      const updates = lines.filter((l) => l.includes('update complete'));
      lastUpdate = updates.length ? updates[updates.length - 1] : null;
    }
  } catch {}
  return NextResponse.json({
    local,
    remote,
    updateAvailable: local && remote ? local !== remote : false,
    lastFetch,
    lastUpdate,
    adminMode,
  });
}
