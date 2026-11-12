import { NextResponse } from 'next/server';
import { getConsumption, getDailyReport, getAttackLog, getRouterLog, getOutages } from '../../../lib/queries';
import { guardApiRequest } from '../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

function toCsv(rows: any[]): string {
  if (rows.length === 0) return '';
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const escape = (v: any) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') v = JSON.stringify(v);
    let s = String(v);
    // Prevent CSV Formula Injection (DDE / Excel / Numbers macro execution)
    if (/^[=+\-@\t\r]/.test(s) && !/^-[0-9]+(?:\.[0-9]+)?$/.test(s)) {
      s = `'${s}`;
    }
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(','));
  return lines.join('\n');
}

export async function GET(req: Request) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const rawFormat = url.searchParams.get('format') ?? 'json';
  const format: 'csv' | 'json' = rawFormat === 'csv' ? 'csv' : 'json';
  let payload: any = null;
  switch (kind) {
    case 'consumption':
      payload = getConsumption();
      break;
    case 'daily': {
      const report = getDailyReport(30);
      // Flatten to rows of {mac, label, day, bytes_down, bytes_up}
      payload = report.devices.flatMap((d) =>
        d.daily.map((day) => ({
          mac: d.mac, label: d.label, category: d.category,
          day: new Date(day.day_ts).toISOString().slice(0, 10),
          bytes_down: day.bytes_down, bytes_up: day.bytes_up,
        }))
      );
      break;
    }
    case 'attacks':
      payload = getAttackLog({ limit: 10000 });
      break;
    case 'syslog':
      payload = getRouterLog(10000);
      break;
    case 'outages':
      payload = getOutages(1000);
      break;
    default:
      return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
  }

  const filename = `${kind}.${format}`;
  if (format === 'csv') {
    const csv = Array.isArray(payload) ? toCsv(payload) : '';
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
