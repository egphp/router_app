import { redirect } from 'next/navigation';
import fs from 'node:fs';
import path from 'node:path';
import { SetupClient } from '../../components/SetupClient';

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

export default function SetupPage({ searchParams }: { searchParams?: { force?: string } }) {
  const configured = liveConfigured();
  // If already configured and the user didn't ask explicitly to edit (?force=1),
  // bounce them to the dashboard. This handles browser cache + stale URLs.
  if (configured && !searchParams?.force) {
    redirect('/');
  }
  return <SetupClient alreadyConfigured={configured} />;
}
