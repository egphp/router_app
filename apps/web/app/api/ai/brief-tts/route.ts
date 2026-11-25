import { NextResponse } from 'next/server';
import {
  buildSpokenNetworkSummary,
  getAiSettings,
  resolveGeminiApiKey,
  synthesizeBriefSpeechWav,
} from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: { withAudio?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const conn = db();
  const { scriptAr, modelUsed } = await buildSpokenNetworkSummary(conn);
  const { apiKey } = resolveGeminiApiKey(conn);
  const cfg = getAiSettings(conn);

  let audioBase64: string | null = null;
  let mimeType: string | null = null;

  if (body.withAudio !== false && apiKey && cfg.enabled) {
    try {
      const wav = await synthesizeBriefSpeechWav(apiKey, scriptAr);
      if (wav) {
        audioBase64 = wav.audioBase64;
        mimeType = wav.mimeType;
      }
    } catch {
      // Return readable Arabic script cleanly if TTS synthesis is unavailable
    }
  }

  return NextResponse.json({
    ok: true,
    scriptAr,
    modelUsed,
    audioBase64,
    mimeType,
  });
}
