import { NextResponse } from 'next/server';
import { getDb } from '@tenda/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT mac, vendor, device_type, os_guess, reverse_dns, last_check FROM device_enrichment ORDER BY last_check DESC LIMIT 500`,
  ).all() as Array<{ mac: string; vendor: string | null; device_type: string | null; os_guess: string | null; reverse_dns: string | null; last_check: number }>;
  const queueDepth = db.prepare(
    `SELECT COUNT(*) AS n FROM devices d LEFT JOIN device_enrichment e ON e.mac = d.mac WHERE e.next_check IS NULL OR e.next_check < ?`,
  ).get(Date.now()) as { n: number };
  return NextResponse.json({
    enriched: rows,
    queue_depth: queueDepth.n,
  });
}
