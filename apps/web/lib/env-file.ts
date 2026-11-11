import fs from 'node:fs';
import path from 'node:path';

export function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function resolveEnvPath(): string {
  return path.join(resolveRepoRoot(), '.env');
}

export function readEnvFile(): string {
  try {
    return fs.readFileSync(resolveEnvPath(), 'utf-8');
  } catch {
    return '';
  }
}

export function readEnvValue(key: string): string {
  const live = process.env[key];
  if (typeof live === 'string' && live.trim()) return live.trim();
  const content = readEnvFile();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escaped}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

export function upsertEnvValues(values: Record<string, string>): void {
  const envPath = resolveEnvPath();
  const lines = readEnvFile().split('\n');
  for (const [key, value] of Object.entries(values)) {
    const nextLine = `${key}=${sanitizeEnvValue(value)}`;
    const idx = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (idx >= 0) {
      lines[idx] = nextLine;
    } else {
      if (lines.length && lines[lines.length - 1] === '') lines[lines.length - 1] = nextLine;
      else lines.push(nextLine);
    }
    process.env[key] = value;
  }
  const tmpPath = `${envPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${lines.join('\n').replace(/\n*$/, '')}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, envPath);
}

export function removeEnvKeys(keys: string[]): void {
  const envPath = resolveEnvPath();
  if (!fs.existsSync(envPath)) return;
  const keySet = new Set(keys);
  const filtered = readEnvFile()
    .split('\n')
    .filter((line) => {
      const eq = line.indexOf('=');
      if (eq <= 0) return true;
      return !keySet.has(line.slice(0, eq).trim());
    });
  for (const k of keys) delete process.env[k];
  const tmpPath = `${envPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${filtered.join('\n').replace(/\n*$/, '')}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, envPath);
}

function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}
