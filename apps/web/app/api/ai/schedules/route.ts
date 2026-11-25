import { NextResponse } from 'next/server';
import {
  PiiSessionSanitizer,
  getAiSettings,
  parseNaturalQosSchedule,
  resolveGeminiApiKey,
} from '@tenda/shared';
import { db } from '../../../../lib/db';
import { getQosSchedules } from '../../../../lib/queries';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

function getControlBase(): string {
  return `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;
}

async function pingSchedulerTick(): Promise<void> {
  try {
    await fetch(`${getControlBase()}/ai/qos-schedules/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    // Poller evaluates schedules automatically every 60s if momentarily busy
  }
}

function localFallbackParsePrompt(prompt: string): {
  name: string;
  days_mask: string;
  start_hhmm: string;
  end_hhmm: string;
  categories: string[];
  download_limit_kbs: number;
  upload_limit_kbs: number;
  wan_port: 'WAN1' | 'WAN2' | null;
  summary_ar: string;
} {
  const lower = prompt.toLowerCase();
  const categories: string[] = [];
  if (/شاش|تلفز|tv|stream/i.test(prompt)) categories.push('tv', 'streaming');
  if (/لعب|بلايستيشن|اكسبوكس|كونسول|game|ps5|xbox/i.test(prompt)) categories.push('game_console');
  if (/كاميرا|camera/i.test(prompt)) categories.push('camera');
  if (/موبايل|تليفون|هاتف|phone/i.test(prompt)) categories.push('phone');
  if (categories.length === 0) categories.push('tv', 'game_console');

  const timeMatches = [...prompt.matchAll(/(\d{1,2})(?::(\d{2}))?/g)]
    .map((m) => ({ h: Number(m[1]), min: Number(m[2] ?? '0') }))
    .filter((t) => t.h >= 0 && t.h <= 23 && t.min >= 0 && t.min <= 59);
  const startHhmm = timeMatches[0]
    ? `${String(timeMatches[0].h).padStart(2, '0')}:${String(timeMatches[0].min).padStart(2, '0')}`
    : '09:00';
  const endHhmm = timeMatches[1]
    ? `${String(timeMatches[1].h).padStart(2, '0')}:${String(timeMatches[1].min).padStart(2, '0')}`
    : '17:00';

  const isWorkdays = /عمل|أحد|خميس|workday|weekday/i.test(prompt);
  const daysMask = isWorkdays ? '0,1,2,3,4' : '0,1,2,3,4,5,6';

  let dl = 1024;
  let ul = 256;
  if (lower.includes('sd') || /256/.test(prompt)) {
    dl = 256;
    ul = 64;
  } else if (lower.includes('hd') || /2048/.test(prompt)) {
    dl = 2048;
    ul = 512;
  }

  const wanPort = /wan\s*2|خط\s*2|التاني|الثاني/i.test(prompt)
    ? 'WAN2'
    : /wan\s*1|خط\s*1|الأول|الاول/i.test(prompt)
    ? 'WAN1'
    : null;

  return {
    name: prompt.trim().slice(0, 60) || 'قاعدة جدولة ذكية',
    days_mask: daysMask,
    start_hhmm: startHhmm,
    end_hhmm: endHhmm,
    categories: [...new Set(categories)],
    download_limit_kbs: dl,
    upload_limit_kbs: ul,
    wan_port: wanPort,
    summary_ar: `جدولة تلقائية من ${startHhmm} إلى ${endHhmm} بسرعة ↓ ${dl} KB/s للفئات (${categories.join(', ')})`,
  };
}

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  return NextResponse.json({ ok: true, schedules: getQosSchedules() });
}

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const conn = db();
  const now = Date.now();
  const naturalPrompt = typeof body.naturalPrompt === 'string' ? body.naturalPrompt.trim().slice(0, 600) : '';

  let name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  let daysMask = typeof body.days_mask === 'string' ? body.days_mask.trim() : '0,1,2,3,4,5,6';
  let startHhmm = typeof body.start_hhmm === 'string' ? body.start_hhmm.trim() : '09:00';
  let endHhmm = typeof body.end_hhmm === 'string' ? body.end_hhmm.trim() : '17:00';
  let downloadLimitKbs = Math.max(0, Math.min(128_000, Math.round(Number(body.download_limit_kbs ?? 1024))));
  let uploadLimitKbs = Math.max(0, Math.min(128_000, Math.round(Number(body.upload_limit_kbs ?? 256))));
  let wanPort: string | null =
    body.wan_port === 'WAN1' || body.wan_port === 1
      ? 'WAN1'
      : body.wan_port === 'WAN2' || body.wan_port === 2
      ? 'WAN2'
      : null;
  let selector: { macs?: string[]; categories?: string[] } = {
    macs: Array.isArray(body.macs) ? body.macs.filter((m): m is string => typeof m === 'string') : [],
    categories: Array.isArray(body.categories)
      ? body.categories.filter((c): c is string => typeof c === 'string')
      : [],
  };
  let summaryAr = 'تم حفظ الجدولة الزمنية وتفعيلها.';

  if (naturalPrompt) {
    const { apiKey } = resolveGeminiApiKey(conn);
    const cfg = getAiSettings(conn);
    if (apiKey && cfg.enabled) {
      try {
        const sanitizer = new PiiSessionSanitizer(conn);
        const devices = conn
          .prepare(
            `SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label, category
             FROM devices ORDER BY last_seen DESC LIMIT 50`,
          )
          .all() as Array<{ mac: string; label: string; category: string | null }>;
        const tokenCatalog = devices.map((d) => ({
          token: sanitizer.registerMac(d.mac, d.label),
          category: d.category,
        }));
        const parsed = await parseNaturalQosSchedule(
          apiKey,
          sanitizer.sanitizeText(naturalPrompt),
          JSON.stringify(tokenCatalog),
        );
        name = sanitizer.detokenizeText(parsed.name).slice(0, 80);
        daysMask = parsed.days_mask;
        startHhmm = parsed.start_hhmm;
        endHhmm = parsed.end_hhmm;
        downloadLimitKbs = parsed.download_limit_kbs;
        uploadLimitKbs = parsed.upload_limit_kbs;
        wanPort = parsed.wan_port === 1 ? 'WAN1' : parsed.wan_port === 2 ? 'WAN2' : null;
        const resolvedMacs = parsed.mac_tokens
          .map((tok) => sanitizer.resolveMacToken(tok))
          .filter((m): m is string => Boolean(m));
        selector = {
          macs: resolvedMacs,
          categories: parsed.categories,
        };
        summaryAr = sanitizer.detokenizeText(parsed.summary_ar);
      } catch {
        const fb = localFallbackParsePrompt(naturalPrompt);
        name = fb.name;
        daysMask = fb.days_mask;
        startHhmm = fb.start_hhmm;
        endHhmm = fb.end_hhmm;
        downloadLimitKbs = fb.download_limit_kbs;
        uploadLimitKbs = fb.upload_limit_kbs;
        wanPort = fb.wan_port;
        selector = { categories: fb.categories, macs: [] };
        summaryAr = fb.summary_ar;
      }
    } else {
      const fb = localFallbackParsePrompt(naturalPrompt);
      name = fb.name;
      daysMask = fb.days_mask;
      startHhmm = fb.start_hhmm;
      endHhmm = fb.end_hhmm;
      downloadLimitKbs = fb.download_limit_kbs;
      uploadLimitKbs = fb.upload_limit_kbs;
      wanPort = fb.wan_port;
      selector = { categories: fb.categories, macs: [] };
      summaryAr = fb.summary_ar;
    }
  }

  if (!name) name = 'جدولة سرعة ذكية';
  if (!/^\d{2}:\d{2}$/.test(startHhmm) || !/^\d{2}:\d{2}$/.test(endHhmm)) {
    return NextResponse.json({ ok: false, error: 'صيغة التوقيت يجب أن تكون HH:MM' }, { status: 400 });
  }

  conn
    .prepare(
      `INSERT INTO ai_qos_schedules
         (name, natural_prompt, days_mask, start_hhmm, end_hhmm, target_selector_json,
          download_limit_kbs, upload_limit_kbs, wan_port, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      name,
      naturalPrompt || null,
      daysMask,
      startHhmm,
      endHhmm,
      JSON.stringify(selector),
      downloadLimitKbs,
      uploadLimitKbs,
      wanPort,
      now,
      now,
    );

  await pingSchedulerTick();
  return NextResponse.json({ ok: true, summaryAr, schedules: getQosSchedules() });
}

export async function PATCH(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: { id?: unknown; enabled?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: 'Invalid schedule id' }, { status: 400 });
  }

  const conn = db();
  conn
    .prepare(`UPDATE ai_qos_schedules SET enabled = ?, updated_at = ? WHERE id = ?`)
    .run(body.enabled ? 1 : 0, Date.now(), id);

  await pingSchedulerTick();
  return NextResponse.json({ ok: true, schedules: getQosSchedules() });
}

export async function DELETE(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: { id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    const url = new URL(req.url);
    body = { id: url.searchParams.get('id') };
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: 'Invalid schedule id' }, { status: 400 });
  }

  const conn = db();
  // Disable first and let QosScheduleRunner revert any active router override before deleting the row
  conn.prepare(`UPDATE ai_qos_schedules SET enabled = 0, updated_at = ? WHERE id = ?`).run(Date.now(), id);
  await pingSchedulerTick();
  conn.prepare(`DELETE FROM ai_qos_schedules WHERE id = ?`).run(id);

  return NextResponse.json({ ok: true, schedules: getQosSchedules() });
}
