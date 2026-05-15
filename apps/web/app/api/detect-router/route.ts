import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import os from 'node:os';

export const dynamic = 'force-dynamic';

/**
 * Detect the LAN router IP by reading the system's default gateway.
 * Works on Linux (ip route) and macOS (netstat -rn). Falls back to scanning
 * common defaults if both fail.
 */
function detectGateway(): string | null {
  // Linux
  try {
    const out = execSync('ip -4 route show default', { encoding: 'utf-8', timeout: 1500 });
    // "default via 192.168.5.1 dev wlan0 proto dhcp ..."
    const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  // macOS
  try {
    const out = execSync('route -n get default 2>/dev/null', { encoding: 'utf-8', timeout: 1500 });
    const m = out.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  // BSD / fallback
  try {
    const out = execSync('netstat -rn -f inet', { encoding: 'utf-8', timeout: 1500 });
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

export async function GET() {
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
