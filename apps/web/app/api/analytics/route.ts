import { NextResponse } from 'next/server';
import {
  getHeatmap, getConcurrentDevices, getTopTalkers, getAnomalies, getCategoryBreakdown, getRouterUptimeSeries
} from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  switch (kind) {
    case 'heatmap': {
      const mac = url.searchParams.get('mac');
      const days = Number(url.searchParams.get('days') ?? '14');
      return NextResponse.json({ data: getHeatmap(mac, days) });
    }
    case 'concurrent': {
      const minutes = Number(url.searchParams.get('minutes') ?? `${60 * 24}`);
      return NextResponse.json({ data: getConcurrentDevices(minutes) });
    }
    case 'top': {
      const range = (url.searchParams.get('range') ?? 'today') as any;
      const limit = Number(url.searchParams.get('limit') ?? '10');
      return NextResponse.json({ data: getTopTalkers(range, limit) });
    }
    case 'anomalies': {
      const threshold = Number(url.searchParams.get('threshold') ?? '3');
      return NextResponse.json({ data: getAnomalies(threshold) });
    }
    case 'categories': {
      const range = (url.searchParams.get('range') ?? 'today') as any;
      return NextResponse.json({ data: getCategoryBreakdown(range) });
    }
    case 'uptime': {
      const days = Number(url.searchParams.get('days') ?? '30');
      return NextResponse.json({ data: getRouterUptimeSeries(days) });
    }
    default:
      return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
  }
}
