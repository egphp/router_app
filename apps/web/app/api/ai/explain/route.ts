import { NextResponse } from 'next/server';
import { getOrGenerateEventExplanation } from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

const VALID_SCOPES = new Set([
  'alert',
  'security',
  'attack',
  'outage',
  'anomaly',
  'wan_advisor',
  'wifi_map',
  'integrity_watchdog',
]);

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: {
    scopeType?: string;
    scopeKey?: string;
    contextPayload?: Record<string, unknown>;
    forceRefresh?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const scopeType = String(body.scopeType ?? '').trim();
  const scopeKey = String(body.scopeKey ?? '').trim().slice(0, 180);
  if (!VALID_SCOPES.has(scopeType) || !scopeKey) {
    return NextResponse.json({ ok: false, error: 'Invalid scopeType or scopeKey' }, { status: 400 });
  }

  const conn = db();
  const explanation = await getOrGenerateEventExplanation(conn, {
    scopeType: scopeType as
      | 'alert'
      | 'security'
      | 'attack'
      | 'outage'
      | 'anomaly'
      | 'wan_advisor'
      | 'wifi_map'
      | 'integrity_watchdog',
    scopeKey,
    contextPayload:
      body.contextPayload && typeof body.contextPayload === 'object' ? body.contextPayload : {},
    forceRefresh: Boolean(body.forceRefresh),
  });

  return NextResponse.json({ ok: true, explanation });
}
