import { redirect } from 'next/navigation';
import fs from 'node:fs';
import path from 'node:path';
import { SetupClient } from '../../components/SetupClient';
import { requireServerBiometricAuth } from '../../lib/server-auth-guard';

export const dynamic = 'force-dynamic';

function resolveEnvPath(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const root = path.join(dir, '.env');
      return fs.existsSync(root) ? root : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function liveConfigured(): boolean {
  if ((process.env.ROUTER_PASSWORD ?? '').trim().length > 0) return true;
  const p = resolveEnvPath();
  if (!p) return false;
  try {
    const content = fs.readFileSync(p, 'utf-8');
    const m = content.match(/^ROUTER_PASSWORD=(.+)$/m);
    return !!(m && m[1].trim().length > 0);
  } catch {
    return false;
  }
}

export default async function SetupPage({ searchParams }: { searchParams?: Promise<{ force?: string }> }) {
  await requireServerBiometricAuth('/setup');
  const sp = searchParams ? await searchParams : undefined;
  const configured = liveConfigured();
  if (configured && !sp?.force) {
    redirect('/');
  }
  return <SetupClient alreadyConfigured={configured} />;
}
