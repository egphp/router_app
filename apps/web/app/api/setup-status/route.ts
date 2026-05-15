import { NextResponse } from 'next/server';
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
  const envPath = path.join(resolveRepoRoot(), '.env');
  let configured = false;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^ROUTER_PASSWORD=(.+)$/m);
    configured = !!(match && match[1].trim().length > 0);
  } catch {
    configured = false;
  }
  return NextResponse.json({ configured });
}
