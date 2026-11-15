import { NextResponse } from 'next/server';
import { getDevice } from '../../../../../lib/queries';
import { guardApiRequest } from '../../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const MAX_SPEED_LIMIT_KBS = 128_000;
const CONTROL_BASE = `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;

export async function POST(req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const { mac } = await ctx.params;
  const macUp = decodeURIComponent(mac).trim().toUpperCase();
  if (!MAC_RE.test(macUp)) {
    return NextResponse.json({ ok: false, error: 'Invalid MAC address' }, { status: 400 });
  }

  let body: {
    download_limit_kbs?: unknown;
    upload_limit_kbs?: unknown;
    wan_port?: unknown;
    wan_group_name?: unknown;
    dhcp_reserved?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const device = getDevice(macUp) as {
    mac: string;
    ip?: string | null;
    reserved_ip?: string | null;
    custom_label?: string | null;
    router_remark?: string | null;
    hostname?: string | null;
    download_limit_kbs?: number;
    upload_limit_kbs?: number;
  } | undefined;

  if (!device) {
    return NextResponse.json({ ok: false, error: 'Device not found' }, { status: 404 });
  }

  const wantsQos = body.download_limit_kbs !== undefined || body.upload_limit_kbs !== undefined;
  const wantsWan = body.wan_port !== undefined;
  const wantsDhcpReserve = body.dhcp_reserved !== undefined;
  if (!wantsQos && !wantsWan && !wantsDhcpReserve) {
    return NextResponse.json({ ok: false, error: 'Nothing to update' }, { status: 400 });
  }

  const payload: Record<string, unknown> = { mac: macUp };
  const targetIp = (device.ip || device.reserved_ip || '').trim();
  const labelHint = device.custom_label || device.router_remark || device.hostname || null;

  if (wantsDhcpReserve) {
    if (typeof body.dhcp_reserved !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'dhcp_reserved must be a boolean' }, { status: 400 });
    }
    payload.dhcpReserved = body.dhcp_reserved;
    if (body.dhcp_reserved) {
      if (!targetIp) {
        return NextResponse.json(
          { ok: false, code: 'MISSING_DEVICE_IP', error: 'الجهاز ليس له عنوان IP معروف حالياً لتثبيته على الراوتر.' },
          { status: 400 },
        );
      }
      payload.ip = targetIp;
      payload.labelHint = labelHint;
    }
  }

  if (wantsQos) {
    const dl = body.download_limit_kbs !== undefined
      ? Math.round(Number(body.download_limit_kbs))
      : Number(device.download_limit_kbs ?? 0);
    const ul = body.upload_limit_kbs !== undefined
      ? Math.round(Number(body.upload_limit_kbs))
      : Number(device.upload_limit_kbs ?? 0);

    if (
      !Number.isFinite(dl) || dl < 0 || dl > MAX_SPEED_LIMIT_KBS ||
      !Number.isFinite(ul) || ul < 0 || ul > MAX_SPEED_LIMIT_KBS
    ) {
      return NextResponse.json(
        { ok: false, error: `Speed limits must be integers between 0 and ${MAX_SPEED_LIMIT_KBS} KB/s` },
        { status: 400 },
      );
    }
    payload.downloadLimitKBs = dl;
    payload.uploadLimitKBs = ul;
  }

  if (wantsWan) {
    if (typeof body.wan_port !== 'string' || !body.wan_port.trim()) {
      return NextResponse.json({ ok: false, error: 'Invalid WAN port value' }, { status: 400 });
    }
    if (!targetIp) {
      return NextResponse.json(
        { ok: false, code: 'MISSING_DEVICE_IP', error: 'الجهاز ليس له عنوان IP معروف حالياً لربطه بـ WAN محدد.' },
        { status: 400 },
      );
    }
    payload.ip = targetIp;
    payload.wanPort = body.wan_port.trim();
    payload.labelHint = labelHint;
    if (typeof body.wan_group_name === 'string' && body.wan_group_name.trim()) {
      if (body.wan_group_name.trim().length > 32) {
        return NextResponse.json({ ok: false, error: 'IP group name is too long' }, { status: 400 });
      }
      payload.wanGroupName = body.wan_group_name.trim();
    }
  }

  try {
    const resp = await fetch(`${CONTROL_BASE}/device-control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const result = await resp.json().catch(() => ({ ok: false, error: 'Invalid response from control daemon' }));
    if (!resp.ok || !result.ok) {
      return NextResponse.json(
        { ok: false, code: result.code, error: result.error ?? 'Failed to apply router control' },
        { status: resp.status >= 400 && resp.status < 600 ? resp.status : 500 },
      );
    }

    const updatedDevice = getDevice(macUp);
    return NextResponse.json({
      ok: true,
      qos: result.qos ?? null,
      wan: result.wan ?? null,
      dhcp: result.dhcp ?? null,
      device: updatedDevice ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Poller control server unreachable: ${String(err)}` },
      { status: 502 },
    );
  }
}
