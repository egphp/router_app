import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

/**
 * Detect the LAN router IP by reading the system's default gateway.
 * Works on Linux (ip route) and macOS (netstat -rn). Falls back to scanning
 * common defaults if both fail.
 */
function detectGateway(): string | null {
  // Linux (execFileSync without shell prevents any shell metacharacter surface)
  try {
    const out = execFileSync('ip', ['-4', 'route', 'show', 'default'], { encoding: 'utf-8', timeout: 1500 });
    const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  // macOS
  try {
    const out = execFileSync('route', ['-n', 'get', 'default'], {
      encoding: 'utf-8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  // BSD / fallback
  try {
    const out = execFileSync('netstat', ['-rn', '-f', 'inet'], { encoding: 'utf-8', timeout: 1500 });
    const line = out.split('\n').find((l) => l.startsWith('default'));
    if (line) {
      const m = line.match(/default\s+(\d+\.\d+\.\d+\.\d+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function localSubnetGuess(): { lanIp: string | null; guesses: string[] } {
  const ifaces = os.networkInterfaces();
  const guesses = new Set<string>();
  let lanIp: string | null = null;
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const a of list) {
      if (a.family !== 'IPv4' || a.internal) continue;
      lanIp = lanIp ?? a.address;
      // Most home routers sit at .1 of the local subnet
      const parts = a.address.split('.');
      if (parts.length === 4) {
        guesses.add(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
      }
    }
  }
  return { lanIp, guesses: [...guesses] };
}

export async function GET(req: Request) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  const gateway = detectGateway();
  const { lanIp, guesses } = localSubnetGuess();
  // Prefer the gateway; if missing, prefer the first .1 subnet guess
  const detected = gateway ?? guesses[0] ?? null;
  return NextResponse.json({
    detected,
    gateway,
    lanIp,
    candidates: gateway ? [gateway, ...guesses.filter((g) => g !== gateway)] : guesses,
  });
}
