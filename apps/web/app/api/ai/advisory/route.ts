import { NextResponse } from 'next/server';
import { analyzeWanAndWifiHealth, runDataIntegrityWatchdog } from '@tenda/shared';
import { db } from '../../../../lib/db';
import { getSyslogClusters } from '../../../../lib/queries';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const conn = db();
  const health = analyzeWanAndWifiHealth(conn);
  const integrity = runDataIntegrityWatchdog(conn);
  const syslogClusters = getSyslogClusters(25);

  return NextResponse.json({
    ok: true,
    wanFindings: health.wanFindings,
    wifiFindings: health.wifiFindings,
    integrity,
    syslogClusters,
  });
}
