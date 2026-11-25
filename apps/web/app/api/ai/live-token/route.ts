import { NextResponse } from 'next/server';
import {
  ALLOWED_READONLY_SCHEMA_SUMMARY,
  PiiSessionSanitizer,
  buildNetworkLiveSnapshot,
  getAiSettings,
  mintLiveEphemeralToken,
  resolveGeminiApiKey,
} from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const conn = db();
  const { apiKey } = resolveGeminiApiKey(conn);
  const cfg = getAiSettings(conn);

  if (!apiKey || !cfg.enabled) {
    return NextResponse.json(
      {
        ok: false,
        code: 'AI_KEY_MISSING',
        error: 'أضف مفتاح GEMINI_API_KEY في الإعدادات لتفعيل المشغّل الصوتي الحي (Gemini 3.8 Live).',
      },
      { status: 400 },
    );
  }

  try {
    const minted = await mintLiveEphemeralToken(apiKey);
    const sanitizer = new PiiSessionSanitizer(conn);
    const devices = conn
      .prepare(
        `SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label, vendor, category
         FROM devices ORDER BY last_seen DESC LIMIT 50`,
      )
      .all() as Array<{ mac: string; label: string; vendor: string | null; category: string | null }>;
    const tokenCatalog = devices.map((d) => ({
      token: sanitizer.registerMac(d.mac, d.label),
      vendor: d.vendor,
      category: d.category,
    }));
    const liveSnap = sanitizer.sanitizeValue(buildNetworkLiveSnapshot(conn));

    const systemInstruction = `أنت المشغّل الصوتي الحي لراوتر Tenda W30E (تتحدث باللهجة المصرية الودودة المختصرة جداً).
استخدم أداة query_network_sqlite لقراءة أي أرقام تاريخية أو لحظية بدقة، وأداة propose_router_action لإصدار بطاقة تعديل سرعة أو نقل WAN يعتمدها المالك بضغطة زر.
${ALLOWED_READONLY_SCHEMA_SUMMARY}
رموز الأجهزة: ${JSON.stringify(tokenCatalog)}
ملخص الشبكة الحالي: ${JSON.stringify(liveSnap)}`;

    return NextResponse.json({
      ok: true,
      token: minted.token,
      model: minted.model,
      expiresAt: minted.expiresAt,
      systemInstruction,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'تعذّر إصدار رمز الجلسة الصوتية المؤقت.',
      },
      { status: 502 },
    );
  }
}
