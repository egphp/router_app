import { NextResponse } from 'next/server';
import {
  PiiSessionSanitizer,
  buildNetworkLiveSnapshot,
  executeReadOnlySql,
  type ProposedRouterAction,
} from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: { name?: unknown; args?: Record<string, unknown> } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = String(body.name ?? '');
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const conn = db();
  const sanitizer = new PiiSessionSanitizer(conn);

  // Register deterministic tokens in same order as live-token
  const devices = conn
    .prepare(
      `SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label
       FROM devices ORDER BY last_seen DESC LIMIT 50`,
    )
    .all() as Array<{ mac: string; label: string }>;
  for (const d of devices) {
    sanitizer.registerMac(d.mac, d.label);
  }

  if (name === 'get_live_overview') {
    const snap = sanitizer.sanitizeValue(buildNetworkLiveSnapshot(conn));
    return NextResponse.json({ ok: true, result: snap });
  }

  if (name === 'query_network_sqlite') {
    const rawSql = String(args.sql ?? '');
    const localSql = sanitizer.detokenizeText(rawSql, { preferLabelOverMac: false });
    const sqlRes = executeReadOnlySql(localSql, {
      existingDbForMemoryTests: conn,
      maxRows: 50,
    });
    return NextResponse.json({
      ok: true,
      sqlRan: rawSql,
      result: sanitizer.sanitizeValue(sqlRes),
    });
  }

  if (name === 'propose_router_action') {
    const kind = String(args.kind ?? '') as ProposedRouterAction['kind'];
    const mac = typeof args.mac_token === 'string' ? sanitizer.resolveMacToken(args.mac_token) : null;
    if (!['set_qos', 'move_wan', 'reserve_dhcp', 'dismiss_alert'].includes(kind)) {
      return NextResponse.json({ ok: false, error: 'Unsupported action kind' }, { status: 400 });
    }
    const devRow = mac
      ? (conn
          .prepare(
            `SELECT COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
                    (SELECT ip FROM samples_raw WHERE mac = d.mac AND ip IS NOT NULL ORDER BY ts DESC LIMIT 1) AS ip
             FROM devices d WHERE d.mac = ?`,
          )
          .get(mac) as { label?: string; ip?: string | null } | undefined)
      : undefined;

    const proposedAction: ProposedRouterAction = {
      id: `live-${Date.now().toString(36)}`,
      kind,
      labelAr: sanitizer.detokenizeText(String(args.label_ar ?? 'تنفيذ الإجراء المقترح')),
      mac: mac ?? undefined,
      deviceLabel: devRow?.label ?? mac ?? undefined,
      ip: devRow?.ip ?? undefined,
      downloadLimitKbs:
        typeof args.download_limit_kbs === 'number' ? Math.round(args.download_limit_kbs) : undefined,
      uploadLimitKbs:
        typeof args.upload_limit_kbs === 'number' ? Math.round(args.upload_limit_kbs) : undefined,
      wanPort:
        args.wan_port === 1 || args.wan_port === 'WAN1'
          ? 1
          : args.wan_port === 2 || args.wan_port === 'WAN2'
          ? 2
          : undefined,
      dhcpReserved: kind === 'reserve_dhcp' ? true : undefined,
      alertId: typeof args.alert_id === 'number' ? args.alert_id : undefined,
    };

    return NextResponse.json({
      ok: true,
      proposedAction,
      result: {
        queuedForHumanConfirmation: true,
        note: 'Confirmation card displayed to owner on screen.',
      },
    });
  }

  return NextResponse.json({ ok: false, error: `Unknown live tool: ${name}` }, { status: 400 });
}
