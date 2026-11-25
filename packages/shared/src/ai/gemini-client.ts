import { GoogleGenAI } from '@google/genai';
import { DEVICE_CATEGORIES } from '../oui.js';

export const GEMINI_MODELS = {
  decision: 'gemini-decision-1',
  fastLite: 'gemini-3.5-flash-lite',
  copilot: 'gemini-4-hydrogen',
  forensics: 'gemini-4-argon',
  embedding: 'gemini-embedding-2',
  transcribe: 'gemini-3.5-transcribe',
  tts: 'gemini-3.8-flash-lite-tts',
  live: 'gemini-3.8-live',
} as const;

export type DomainSafetyCategory =
  | 'safe'
  | 'adult'
  | 'malware_phishing'
  | 'gambling'
  | 'vpn_proxy'
  | 'iot_cloud';

export interface DomainDecisionResult {
  domain: string;
  category: DomainSafetyCategory;
  confidence: number;
}

export interface NewDeviceTrustScore {
  trustTier: 'trusted_personal' | 'home_media' | 'iot_restricted' | 'guest_unknown';
  recommendedQosProfile: 'unlimited' | 'hd' | 'sd' | 'strict';
  recommendedDownKbs: number;
  recommendedUpKbs: number;
  recommendedWan: 1 | 2 | null;
  confidence: number;
  rationaleAr: string;
}

export interface DeviceBehavioralProfileResult {
  suggestedLabel: string;
  inferredCategory: string;
  osGuess: string;
  rationaleAr: string;
}

export interface SecurityTriageVerdict {
  isActionableThreat: boolean;
  verdict: 'benign' | 'watch' | 'action_needed';
  confidence: number;
}

export interface StructuredAiExplanation {
  verdict: 'benign' | 'watch' | 'action_needed' | 'info';
  lan_or_wan?: 'lan_only' | 'wan1' | 'wan2' | 'mixed' | null;
  title_ar: string;
  explanation_ar: string;
  recommended_action: {
    kind: 'none' | 'set_qos' | 'move_wan' | 'reserve_dhcp' | 'dismiss_alert';
    label_ar?: string;
    mac_token?: string;
    download_limit_kbs?: number;
    upload_limit_kbs?: number;
    wan_port?: 1 | 2;
  };
  model_used: string;
}

export interface ParsedNaturalQosSchedule {
  name: string;
  days_mask: string;
  start_hhmm: string;
  end_hhmm: string;
  categories: string[];
  mac_tokens: string[];
  download_limit_kbs: number;
  upload_limit_kbs: number;
  wan_port: 1 | 2 | null;
  summary_ar: string;
}

function getV1Client(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

function getBetaClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
}

function getAlphaClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
}

export async function testGeminiConnection(apiKey: string): Promise<{ ok: boolean; model: string; error?: string }> {
  try {
    const ai = getV1Client(apiKey);
    const res = await ai.interactions.create({
      model: GEMINI_MODELS.fastLite,
      store: false,
      input: 'Reply with exact word: READY',
      generation_config: { max_output_tokens: 16 },
    });
    const text = (res.output_text ?? '').trim();
    return { ok: text.length > 0, model: GEMINI_MODELS.fastLite };
  } catch (err) {
    return {
      ok: false,
      model: GEMINI_MODELS.fastLite,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Zero-output-token calibrated domain classification via `gemini-decision-1` (`v1beta`).
 * Sends ONLY deduplicated, normalized anonymous domain strings — NEVER MACs, IPs, or timestamps.
 */
export async function triageDomainsWithDecisionApi(
  apiKey: string,
  domains: string[],
): Promise<DomainDecisionResult[]> {
  const unique = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))].slice(0, 60);
  if (unique.length === 0) return [];

  const beta = getBetaClient(apiKey);
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {};
  unique.forEach((dom, idx) => {
    questions[`d_${idx}`] = {
      type: 'choice',
      instructions: `Classify internet domain "${dom}" for parental adult-content filtering. Note: obscure .xyz/.cc/.live domains used as IPTV/HLS/VOD video CDN edge servers without explicit sexual branding MUST be classified as "safe", NOT "adult" or "malware_phishing". Only classify as "adult" when the domain is a verified explicit pornography or adult webcam site.`,
      criteria: {
        safe: 'Normal website, IPTV/HLS/VOD video streaming CDN edge (.xyz/.cc/.live), cloud infrastructure, OS update, social media, messaging, or unknown generic domain without explicit adult content',
        adult: 'Verified explicit pornography, explicit adult video tube, adult webcam, hentai, or explicit sexual domain',
        malware_phishing: 'Verified credential phishing or known malware C2 domain',
        gambling: 'Verified online casino or sports betting domain',
        vpn_proxy: 'Known commercial VPN endpoint or anonymizer proxy',
        iot_cloud: 'Smart camera, smart home appliance, printer, or IoT telemetry cloud endpoint',
      },
    };
  });

  const resp = await beta.decisions.create({
    model: GEMINI_MODELS.decision,
    input: `Evaluate the following ${unique.length} domain names independently based on global web intelligence:\n${unique.join('\n')}`,
    questions,
  });

  const out: DomainDecisionResult[] = [];
  unique.forEach((domain, idx) => {
    const ans = resp.answers?.[`d_${idx}`];
    if (ans && ans.type === 'choice') {
      const cat = (
        ['safe', 'adult', 'malware_phishing', 'gambling', 'vpn_proxy', 'iot_cloud'].includes(ans.choice)
          ? ans.choice
          : 'safe'
      ) as DomainSafetyCategory;
      out.push({
        domain,
        category: cat,
        confidence: Number.isFinite(ans.confidence) ? ans.confidence : 0.8,
      });
    }
  });
  return out;
}

/**
 * Calibrated zero-output-token trust & QoS recommendation for newly joined devices (`gemini-decision-1`).
 */
export async function scoreNewDeviceTrust(
  apiKey: string,
  sanitizedDeviceJson: string,
): Promise<NewDeviceTrustScore> {
  const beta = getBetaClient(apiKey);
  const resp = await beta.decisions.create({
    model: GEMINI_MODELS.decision,
    input: sanitizedDeviceJson,
    questions: {
      trust_tier: {
        type: 'choice',
        instructions: 'Classify the device role and trust tier on this home/office LAN.',
        criteria: {
          trusted_personal: 'Known workstation, laptop, NAS, or primary personal phone/tablet',
          home_media: 'Smart TV, streaming stick, speaker, or game console needing video bandwidth',
          iot_restricted: 'IP camera, smart plug, ESP32/Tuya microcontroller, or printer that should stay speed-capped',
          guest_unknown: 'Unidentified or randomized-MAC unknown client that should remain restricted until verified',
        },
      },
      qos_tier: {
        type: 'choice',
        instructions: 'Select the safest post-review QoS speed tier for this device.',
        criteria: {
          unlimited: 'Full line speed (0 KB/s limit) for trusted computers/NAS/phones',
          hd: 'HD streaming tier (2048 KB/s down, 512 KB/s up) for TVs and consoles',
          sd: 'Standard quarantine/IoT tier (256 KB/s down, 64 KB/s up) for IoT, smart plugs, and unverified guests',
          strict: 'Strict minimal telemetry tier (128 KB/s down, 32 KB/s up) for suspicious devices',
        },
      },
    },
  });

  const trustAns = resp.answers?.trust_tier;
  const qosAns = resp.answers?.qos_tier;
  const trustTier = (
    trustAns?.type === 'choice' &&
    ['trusted_personal', 'home_media', 'iot_restricted', 'guest_unknown'].includes(trustAns.choice)
      ? trustAns.choice
      : 'guest_unknown'
  ) as NewDeviceTrustScore['trustTier'];

  const qosProfile = (
    qosAns?.type === 'choice' && ['unlimited', 'hd', 'sd', 'strict'].includes(qosAns.choice)
      ? qosAns.choice
      : 'sd'
  ) as NewDeviceTrustScore['recommendedQosProfile'];

  const limits =
    qosProfile === 'unlimited'
      ? { down: 0, up: 0, wan: 1 as const, ar: 'جهاز عمل/شخصي موثوق — يُنصح بفتح السرعة الكاملة بعد التحقق.' }
      : qosProfile === 'hd'
      ? { down: 2048, up: 512, wan: 2 as const, ar: 'جهاز ميديا/ترفيه — يُنصح ببروفايل HD وتوجيهه لخط WAN2 لتخفيف الضغط.' }
      : qosProfile === 'strict'
      ? { down: 128, up: 32, wan: 2 as const, ar: 'جهاز غير معروف الهوية — يُنصح بإبقاء القيد المشدد لحين التأكد.' }
      : { down: 256, up: 64, wan: null, ar: 'جهاز إنترنت أشياء (IoT/كاميرا/ضيف) — إبقاء حد SD يحمي الشبكة من سحب الرفع.' };

  return {
    trustTier,
    recommendedQosProfile: qosProfile,
    recommendedDownKbs: limits.down,
    recommendedUpKbs: limits.up,
    recommendedWan: limits.wan,
    confidence: trustAns?.type === 'choice' ? trustAns.confidence : 0.75,
    rationaleAr: limits.ar,
  };
}

/**
 * Calibrated false-positive triage for heuristic security findings (`gemini-decision-1`).
 */
export async function triageSecurityFinding(
  apiKey: string,
  sanitizedFindingJson: string,
): Promise<SecurityTriageVerdict> {
  const beta = getBetaClient(apiKey);
  const resp = await beta.decisions.create({
    model: GEMINI_MODELS.decision,
    input: sanitizedFindingJson,
    questions: {
      actionable: {
        type: 'noul',
        instructions:
          'Is this router telemetry event a genuine anomaly or security concern rather than normal workstation/server/NVR traffic?',
      },
      severity_choice: {
        type: 'choice',
        instructions: 'Select the operational response level.',
        criteria: {
          benign: 'Expected behavior for this device category (e.g. workstation P2P/dev connections or NVR LAN camera stream)',
          watch: 'Unusual spike worth monitoring but not immediately dangerous',
          action_needed: 'Suspicious exfiltration, IoT upload anomaly, ARP/UDP flood, or subnet spoofing needing throttling/inspection',
        },
      },
    },
  });

  const act = resp.answers?.actionable;
  const sev = resp.answers?.severity_choice;
  const pYes = act?.type === 'noul' ? act.noul : 0.5;
  const verdict = (
    sev?.type === 'choice' && ['benign', 'watch', 'action_needed'].includes(sev.choice)
      ? sev.choice
      : pYes >= 0.65
      ? 'action_needed'
      : pYes >= 0.35
      ? 'watch'
      : 'benign'
  ) as SecurityTriageVerdict['verdict'];

  return {
    isActionableThreat: verdict !== 'benign' && pYes >= 0.4,
    verdict,
    confidence: sev?.type === 'choice' ? sev.confidence : act?.type === 'noul' ? act.confidence : 0.7,
  };
}

/**
 * Behavioral device fingerprinting via `gemini-3.5-flash-lite` structured JSON output.
 */
export async function profileDeviceBehavior(
  apiKey: string,
  sanitizedFeaturesJson: string,
): Promise<DeviceBehavioralProfileResult> {
  const ai = getV1Client(apiKey);
  const res = await ai.interactions.create({
    model: GEMINI_MODELS.fastLite,
    store: false,
    system_instruction:
      'You are an expert network device fingerprinting engine. Infer the device category, operating system, and a clean concise Arabic/English type label strictly from anonymized OUI, Wi-Fi band, connection count, and traffic ratios. Never invent personal names.',
    input: sanitizedFeaturesJson,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: {
        type: 'object',
        properties: {
          suggestedLabel: { type: 'string' },
          inferredCategory: { type: 'string', enum: [...DEVICE_CATEGORIES] },
          osGuess: { type: 'string' },
          rationaleAr: { type: 'string' },
        },
        required: ['suggestedLabel', 'inferredCategory', 'osGuess', 'rationaleAr'],
      },
    },
  });

  const parsed = JSON.parse(res.output_text ?? '{}') as Partial<DeviceBehavioralProfileResult>;
  return {
    suggestedLabel: (parsed.suggestedLabel ?? 'جهاز شبكة').slice(0, 64),
    inferredCategory: DEVICE_CATEGORIES.includes(parsed.inferredCategory as any)
      ? (parsed.inferredCategory as string)
      : 'unknown',
    osGuess: (parsed.osGuess ?? 'Unknown OS').slice(0, 48),
    rationaleAr: (parsed.rationaleAr ?? '').slice(0, 280),
  };
}

/**
 * Contextual Arabic explanation (`Ask Gemini`) using `gemini-4-hydrogen` (or `gemini-4-argon` for deep outage forensics).
 */
export async function generateStructuredExplanation(
  apiKey: string,
  sanitizedContextJson: string,
  opts: { deepForensics?: boolean; systemHint?: string } = {},
): Promise<StructuredAiExplanation> {
  const model = opts.deepForensics ? GEMINI_MODELS.forensics : GEMINI_MODELS.copilot;
  const ai = getV1Client(apiKey);
  const res = await ai.interactions.create({
    model,
    store: false,
    system_instruction:
      opts.systemHint ??
      'أنت مهندس شبكات وأمن سيبراني خبير براوتر Tenda W30E ثنائي الـ WAN. اشرح السبب الجذري بالعربية الواضحة المختصرة (٣-٤ جمل كحد أقصى)، مع احترام الرموز المؤقتة مثل DEV_01 و IP_01 كما هي بالضبط حتى يفكّها النظام محلياً، وحدد إجراءً عملياً واحداً عند الحاجة.',
    input: sanitizedContextJson,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['benign', 'watch', 'action_needed', 'info'] },
          lan_or_wan: { type: 'string', enum: ['lan_only', 'wan1', 'wan2', 'mixed'] },
          title_ar: { type: 'string' },
          explanation_ar: { type: 'string' },
          recommended_action: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['none', 'set_qos', 'move_wan', 'reserve_dhcp', 'dismiss_alert'],
              },
              label_ar: { type: 'string' },
              mac_token: { type: 'string' },
              download_limit_kbs: { type: 'number' },
              upload_limit_kbs: { type: 'number' },
              wan_port: { type: 'number', enum: [1, 2] },
            },
            required: ['kind'],
          },
        },
        required: ['verdict', 'title_ar', 'explanation_ar', 'recommended_action'],
      },
    },
  });

  const parsed = JSON.parse(res.output_text ?? '{}') as Partial<StructuredAiExplanation>;
  return {
    verdict: parsed.verdict ?? 'info',
    lan_or_wan: parsed.lan_or_wan ?? null,
    title_ar: parsed.title_ar ?? 'تحليل الشبكة الذكي',
    explanation_ar: parsed.explanation_ar ?? 'تم فحص المؤشرات الحالية للشبكة.',
    recommended_action: parsed.recommended_action ?? { kind: 'none' },
    model_used: model,
  };
}

/**
 * Natural-language QoS & Multi-WAN schedule parser (`gemini-3.5-flash-lite`).
 */
export async function parseNaturalQosSchedule(
  apiKey: string,
  sanitizedPrompt: string,
  availableDeviceTokensJson: string,
): Promise<ParsedNaturalQosSchedule> {
  const ai = getV1Client(apiKey);
  const res = await ai.interactions.create({
    model: GEMINI_MODELS.fastLite,
    store: false,
    system_instruction: `Convert the user's Arabic or English bandwidth/WAN schedule instruction into a deterministic JSON rule.
Days of week: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday (comma-separated in days_mask, e.g. "0,1,2,3,4").
24-hour times in HH:MM ("09:00", "17:00").
Speeds are in KB/s (0 = unlimited, 256 = SD, 1024 = 1 MB/s, 2048 = HD).
Valid categories: ${DEVICE_CATEGORIES.join(', ')}.
Available device tokens: ${availableDeviceTokensJson}`,
    input: sanitizedPrompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          days_mask: { type: 'string' },
          start_hhmm: { type: 'string' },
          end_hhmm: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          mac_tokens: { type: 'array', items: { type: 'string' } },
          download_limit_kbs: { type: 'number' },
          upload_limit_kbs: { type: 'number' },
          wan_port: { type: 'number' },
          summary_ar: { type: 'string' },
        },
        required: [
          'name',
          'days_mask',
          'start_hhmm',
          'end_hhmm',
          'categories',
          'mac_tokens',
          'download_limit_kbs',
          'upload_limit_kbs',
          'summary_ar',
        ],
      },
    },
  });

  const parsed = JSON.parse(res.output_text ?? '{}') as Record<string, any>;
  const wanRaw = Number(parsed.wan_port);
  return {
    name: String(parsed.name || 'قاعدة جدولة ذكية').slice(0, 80),
    days_mask: String(parsed.days_mask || '0,1,2,3,4,5,6'),
    start_hhmm: /^\d{2}:\d{2}$/.test(String(parsed.start_hhmm)) ? String(parsed.start_hhmm) : '09:00',
    end_hhmm: /^\d{2}:\d{2}$/.test(String(parsed.end_hhmm)) ? String(parsed.end_hhmm) : '17:00',
    categories: Array.isArray(parsed.categories)
      ? parsed.categories.filter((c: unknown) => typeof c === 'string' && DEVICE_CATEGORIES.includes(c as any))
      : [],
    mac_tokens: Array.isArray(parsed.mac_tokens)
      ? parsed.mac_tokens.filter((m: unknown) => typeof m === 'string')
      : [],
    download_limit_kbs: Math.max(0, Math.min(128_000, Math.round(Number(parsed.download_limit_kbs ?? 1024)))),
    upload_limit_kbs: Math.max(0, Math.min(128_000, Math.round(Number(parsed.upload_limit_kbs ?? 256)))),
    wan_port: wanRaw === 1 || wanRaw === 2 ? wanRaw : null,
    summary_ar: String(parsed.summary_ar || 'تم تحويل الوصف إلى قاعدة جدولة زمنية.'),
  };
}

/**
 * Coalesces a burst of router alerts or generates the daily Arabic morning brief (`gemini-3.5-flash-lite`).
 */
export async function summarizeNetworkDigest(
  apiKey: string,
  sanitizedDigestJson: string,
  mode: 'alert_coalesce' | 'morning_brief' | 'voice_brief',
): Promise<string> {
  const ai = getV1Client(apiKey);
  const instruction =
    mode === 'voice_brief'
      ? 'اكتب نشرة صوتية عربية مصرية طبيعية وسلسة جداً تُقرأ في 15 ثانية فقط (حوالي 35 إلى 45 كلمة) تلخص حالة الشبكة الحالية وسرعة الخطين وأعلى جهاز استهلاكاً وأي تنبيهات هامة. احتفظ بالرموز DEV_XX كما هي.'
      : mode === 'morning_brief'
      ? 'أنت مساعد مراقبة الشبكة الصباحي. لخّص تقرير الأمس بالعربية الواضحة في نقاط قصيرة منظمة (إجمالي الاستهلاك، أعلى ٣ أجهزة، الانقطاعات، والحالة الأمنية). احتفظ بالرموز DEV_XX كما هي.'
      : 'ادمج هذه التنبيهات المترابطة في رسالة تليجرام عربية واحدة مركزة وواضحة بدون حشو، مع الاحتفاظ بالرموز DEV_XX و IP_XX كما هي.';

  const res = await ai.interactions.create({
    model: GEMINI_MODELS.fastLite,
    store: false,
    system_instruction: instruction,
    input: sanitizedDigestJson,
  });
  return (res.output_text ?? '').trim();
}

/**
 * Transcribes Arabic/English voice notes (Telegram OGG Opus or browser WebM/WAV) via `gemini-3.5-transcribe`.
 */
export async function transcribeAudioCommand(
  apiKey: string,
  base64Audio: string,
  mimeType: 'audio/ogg' | 'audio/wav' | 'audio/mp3' | 'audio/aac' | 'audio/mpeg' | 'audio/flac' = 'audio/ogg',
): Promise<string> {
  const ai = getBetaClient(apiKey);
  const res = await ai.interactions.create({
    model: GEMINI_MODELS.transcribe,
    store: false,
    input: [
      {
        type: 'audio',
        data: base64Audio,
        mime_type: mimeType,
      },
    ],
  });
  return (res.output_text ?? '').trim();
}

/**
 * Synthesizes a 15-second spoken Arabic network brief via `gemini-3.8-flash-lite-tts` (`v1beta`).
 */
export async function synthesizeBriefSpeechWav(
  apiKey: string,
  arabicScript: string,
): Promise<{ audioBase64: string; mimeType: string } | null> {
  const ai = getBetaClient(apiKey);
  const res = await ai.interactions.create({
    model: GEMINI_MODELS.tts,
    store: false,
    input: arabicScript,
    response_format: {
      type: 'audio',
      mime_type: 'audio/wav',
    },
  });
  const outAudio = (res as any).output_audio as { data?: string; mime_type?: string } | null | undefined;
  if (outAudio?.data) {
    return {
      audioBase64: outAudio.data,
      mimeType: outAudio.mime_type || 'audio/wav',
    };
  }
  // Fallback scan across model_output steps
  const steps = Array.isArray((res as any).steps) ? (res as any).steps : [];
  for (const step of steps) {
    if (step?.type === 'model_output' && Array.isArray(step.content)) {
      for (const part of step.content) {
        if (part?.type === 'audio' && typeof part.data === 'string') {
          return { audioBase64: part.data, mimeType: part.mime_type || 'audio/wav' };
        }
      }
    }
  }
  return null;
}

/**
 * Embeds syslog templates or device behavior summaries into 64-D vectors (`gemini-embedding-2`)
 * with a deterministic local character-trigram hash fallback if offline.
 */
export async function embedTexts64(apiKey: string | null, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (apiKey) {
    try {
      const ai = getV1Client(apiKey);
      const res = await ai.models.embedContent({
        model: GEMINI_MODELS.embedding,
        contents: texts,
        config: { outputDimensionality: 64 },
      });
      if (Array.isArray(res.embeddings) && res.embeddings.length === texts.length) {
        return res.embeddings.map((e) => normalizeVec(e.values ?? localTrigramVector64('')));
      }
    } catch {
      // Graceful fallback to deterministic local 64-D vector
    }
  }
  return texts.map((t) => localTrigramVector64(t));
}

export function localTrigramVector64(text: string): number[] {
  const vec = new Array<number>(64).fill(0);
  const norm = text
    .toLowerCase()
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/g, '<mac>')
    .replace(/\b\d+\b/g, '<n>');
  for (let i = 0; i < norm.length - 2; i++) {
    const h =
      ((norm.charCodeAt(i) * 31 + norm.charCodeAt(i + 1)) * 31 + norm.charCodeAt(i + 2)) >>> 0;
    vec[h % 64] += 1;
  }
  return normalizeVec(vec);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalizeVec(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm <= 0) return v;
  const inv = 1 / Math.sqrt(norm);
  return v.map((x) => Number((x * inv).toFixed(5)));
}

/**
 * Mints a short-lived single-use Ephemeral Token (`v1alpha` `authTokens.create`)
 * so the browser PWA can connect directly to `gemini-3.8-live` over WebSockets
 * WITHOUT ever exposing `GEMINI_API_KEY` to client JavaScript!
 */
export async function mintLiveEphemeralToken(apiKey: string): Promise<{
  token: string;
  model: string;
  expiresAt: string;
}> {
  const alpha = getAlphaClient(apiKey);
  const now = Date.now();
  const expireTime = new Date(now + 15 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now + 90_000).toISOString();
  const created = await alpha.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
    },
  });
  if (!created.name) {
    throw new Error('Failed to mint ephemeral Live API token');
  }
  return {
    token: created.name,
    model: GEMINI_MODELS.live,
    expiresAt: expireTime,
  };
}
