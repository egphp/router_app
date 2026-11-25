import { NextResponse } from 'next/server';
import {
  getAiSettings,
  resolveGeminiApiKey,
  runDataIntegrityWatchdog,
  testGeminiConnection,
  updateAiSettings,
} from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  const conn = db();
  const settings = getAiSettings(conn);
  const integrity = runDataIntegrityWatchdog(conn);
  return NextResponse.json({ ok: true, settings, integrity });
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

  if (body.action === 'test') {
    const candidateKey =
      typeof body.apiKey === 'string' && body.apiKey.trim().length >= 12
        ? body.apiKey.trim()
        : resolveGeminiApiKey(conn).apiKey;
    if (!candidateKey) {
      return NextResponse.json(
        { ok: false, error: 'لا يوجد مفتاح GEMINI_API_KEY محفوظ أو مُدخل للاختبار.' },
        { status: 400 },
      );
    }
    const check = await testGeminiConnection(candidateKey);
    if (!check.ok) {
      return NextResponse.json(
        { ok: false, model: check.model, error: check.error || 'فشل الاتصال بواجهة Gemini.' },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, model: check.model, settings: getAiSettings(conn) });
  }

  const updated = updateAiSettings(conn, {
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    clearSavedKey: body.clearSavedKey === true,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    domainClassifierEnabled:
      typeof body.domainClassifierEnabled === 'boolean' ? body.domainClassifierEnabled : undefined,
    deviceProfilerEnabled:
      typeof body.deviceProfilerEnabled === 'boolean' ? body.deviceProfilerEnabled : undefined,
    securityTriageEnabled:
      typeof body.securityTriageEnabled === 'boolean' ? body.securityTriageEnabled : undefined,
    morningBriefEnabled:
      typeof body.morningBriefEnabled === 'boolean' ? body.morningBriefEnabled : undefined,
    morningBriefHour:
      typeof body.morningBriefHour === 'number' ? body.morningBriefHour : undefined,
    wan1QuotaGb: typeof body.wan1QuotaGb === 'number' ? body.wan1QuotaGb : undefined,
    wan2QuotaGb: typeof body.wan2QuotaGb === 'number' ? body.wan2QuotaGb : undefined,
    billingRenewalDay:
      typeof body.billingRenewalDay === 'number' ? body.billingRenewalDay : undefined,
  });

  return NextResponse.json({ ok: true, settings: updated });
}
