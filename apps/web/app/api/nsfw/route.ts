import { NextResponse } from 'next/server';
import { getDb } from '@tenda/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  const enabledRow = db.prepare(`SELECT value FROM settings WHERE key = 'nsfw_detection'`).get() as { value: string } | undefined;
  const enabled = enabledRow ? enabledRow.value !== 'off' : true;

  const day = Date.now() - 24 * 3600 * 1000;
  const recent = db.prepare(
    `SELECT COUNT(*) as cnt, COUNT(DISTINCT source_mac) as devices FROM nsfw_hits WHERE ts > ?`
  ).get(day) as { cnt: number; devices: number };

  const topDomains = db.prepare(
    `SELECT domain, category, COUNT(*) as hits, MAX(ts) as last_ts FROM nsfw_hits WHERE ts > ? GROUP BY domain ORDER BY hits DESC LIMIT 10`
  ).all(day) as Array<{ domain: string; category: string; hits: number; last_ts: number }>;

  const byDevice = db.prepare(
    `SELECT nh.source_mac, nh.source_ip, COUNT(*) as hits, MAX(nh.ts) as last_ts,
            COALESCE(d.custom_label, d.hostname, d.router_remark, nh.source_mac) AS label
     FROM nsfw_hits nh
     LEFT JOIN devices d ON d.mac = nh.source_mac
     WHERE nh.ts > ? AND nh.source_mac IS NOT NULL
     GROUP BY nh.source_mac ORDER BY hits DESC LIMIT 10`
  ).all(day) as Array<{ source_mac: string; source_ip: string | null; hits: number; last_ts: number; label: string }>;

  return NextResponse.json({
    enabled,
    last_24h: { hits: recent.cnt, devices: recent.devices },
    top_domains: topDomains,
    by_device: byDevice,
  });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const { enabled } = body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'enabled must be boolean' }, { status: 400 });
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('nsfw_detection', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(enabled ? 'on' : 'off');
  return NextResponse.json({ ok: true, enabled });
}
