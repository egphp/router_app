import type Database from 'better-sqlite3';
import type { ProposedRouterAction } from '@tenda/shared';
import type { RouterClient } from './router-client.js';
import type { Sampler } from './sampler.js';
import { isValidLanIpv4, markDeviceAutoQosReviewed, MAX_ROUTER_SPEED_LIMIT_KBS } from './traffic-control.js';

export interface ExecutedActionResult {
  ok: boolean;
  summaryAr: string;
  error?: string;
}

export async function applyProposedRouterAction(
  db: Database.Database,
  router: RouterClient,
  sampler: Sampler | undefined,
  action: Partial<ProposedRouterAction>,
): Promise<ExecutedActionResult> {
  const now = Date.now();
  const kind = action.kind;
  const mac = typeof action.mac === 'string' ? action.mac.trim().toUpperCase() : '';

  if (kind === 'dismiss_alert') {
    if (typeof action.alertId === 'number' && Number.isFinite(action.alertId)) {
      db.prepare(`UPDATE alerts SET dismissed_at = ? WHERE id = ?`).run(now, action.alertId);
      return { ok: true, summaryAr: `تم تجاهل التنبيه رقم #${action.alertId}.` };
    }
    if (mac) {
      db.prepare(`UPDATE alerts SET dismissed_at = ? WHERE mac = ? AND dismissed_at IS NULL`).run(now, mac);
      return { ok: true, summaryAr: `تم تجاهل التنبيهات المفتوحة للجهاز ${mac}.` };
    }
    return { ok: false, summaryAr: '', error: 'alertId or mac required' };
  }

  if (kind === 'rename_device') {
    if (!mac || typeof action.newCustomLabel !== 'string' || !action.newCustomLabel.trim()) {
      return { ok: false, summaryAr: '', error: 'mac and newCustomLabel required' };
    }
    const label = action.newCustomLabel.trim().slice(0, 64);
    db.prepare(`UPDATE devices SET custom_label = ?, updated_at = ? WHERE mac = ?`).run(label, now, mac);
    return { ok: true, summaryAr: `تم تحديث اسم الجهاز إلى "${label}".` };
  }

  // Resolve device IP & label from DB if omitted
  let ip = typeof action.ip === 'string' && action.ip.trim() ? action.ip.trim() : null;
  let labelHint = typeof action.deviceLabel === 'string' && action.deviceLabel.trim() ? action.deviceLabel.trim() : null;
  if (mac && (!ip || !labelHint)) {
    const dev = db
      .prepare(`
        SELECT COALESCE(custom_label, router_remark, hostname, mac) AS label,
               COALESCE(
                 (SELECT q.ip FROM router_qos_limits q WHERE q.mac = devices.mac),
                 (SELECT s.ip FROM samples_raw s WHERE s.mac = devices.mac AND s.ip IS NOT NULL ORDER BY s.ts DESC LIMIT 1)
               ) AS latest_ip
        FROM devices WHERE mac = ?
      `)
      .get(mac) as { label?: string; latest_ip?: string | null } | undefined;
    if (!labelHint && dev?.label) labelHint = dev.label;
    if (!ip && dev?.latest_ip) ip = dev.latest_ip;
  }

  if (kind === 'set_qos') {
    if (!mac) return { ok: false, summaryAr: '', error: 'mac is required for set_qos' };
    const dl = Math.max(0, Math.min(MAX_ROUTER_SPEED_LIMIT_KBS, Math.round(Number(action.downloadLimitKbs ?? 0))));
    const ul = Math.max(0, Math.min(MAX_ROUTER_SPEED_LIMIT_KBS, Math.round(Number(action.uploadLimitKbs ?? 0))));
    const res = await router.setDeviceSpeedLimit({
      mac,
      downloadLimitKBs: dl,
      uploadLimitKBs: ul,
      remark: labelHint ?? undefined,
    });
    if (!res.ok) {
      return { ok: false, summaryAr: '', error: res.error ?? res.code ?? 'router QoS failed' };
    }
    markDeviceAutoQosReviewed(db, mac, now);
    db.prepare(`UPDATE devices SET is_new = 0, updated_at = ? WHERE mac = ? AND is_new = 1`).run(now, mac);
    db.prepare(`UPDATE alerts SET dismissed_at = ? WHERE kind = 'new_device' AND mac = ? AND dismissed_at IS NULL`).run(now, mac);
    if (sampler) await sampler.refreshTrafficControls().catch(() => {});
    return {
      ok: true,
      summaryAr:
        dl === 0 && ul === 0
          ? `تم فتح السرعة الكاملة (Unlimited) للجهاز ${labelHint ?? mac}.`
          : `تم ضبط سقف السرعة للجهاز ${labelHint ?? mac} عند ↓ ${dl} KB/s · ↑ ${ul} KB/s.`,
    };
  }

  if (kind === 'move_wan') {
    const wanNum = Number(action.wanPort);
    if (wanNum !== 1 && wanNum !== 2) {
      return { ok: false, summaryAr: '', error: 'wanPort must be 1 or 2' };
    }
    if (!ip || !isValidLanIpv4(ip)) {
      return { ok: false, summaryAr: '', error: 'Device has no active LAN IPv4 address yet' };
    }
    const res = await router.setDeviceWanBinding({
      ip,
      labelHint,
      wanPort: `WAN${wanNum}`,
    });
    if (!res.ok) {
      return { ok: false, summaryAr: '', error: res.error ?? res.code ?? 'router WAN routing failed' };
    }
    if (sampler) await sampler.refreshTrafficControls().catch(() => {});
    return {
      ok: true,
      summaryAr: `تم توجيه الجهاز ${labelHint ?? ip} إلى خط WAN${wanNum}.`,
    };
  }

  if (kind === 'reserve_dhcp') {
    if (!mac || !ip || !isValidLanIpv4(ip)) {
      return { ok: false, summaryAr: '', error: 'Valid mac and LAN IPv4 required for DHCP reservation' };
    }
    const res = await router.setDeviceDhcpReservation({
      mac,
      ip,
      remark: labelHint,
      allowUpdateIp: true,
    });
    if (!res.ok) {
      return { ok: false, summaryAr: '', error: res.error ?? res.code ?? 'DHCP reservation failed' };
    }
    if (sampler) await sampler.refreshDhcpReservations().catch(() => {});
    return {
      ok: true,
      summaryAr: `تم تثبيت عنوان ${ip} في حجز DHCP للجهاز ${labelHint ?? mac}.`,
    };
  }

  return { ok: false, summaryAr: '', error: `Unsupported action kind: ${String(kind)}` };
}
