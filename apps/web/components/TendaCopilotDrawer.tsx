'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { GoogleGenAI } from '@google/genai';
import {
  Check,
  Database,
  Loader2,
  Mic,
  MicOff,
  Play,
  Send,
  Sparkles,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { ProposedActionClient } from './AskGeminiButton';

interface ChatItem {
  id: string;
  role: 'user' | 'model';
  content: string;
  sqlQueriesRun?: string[];
  proposedActions?: ProposedActionClient[];
  modelUsed?: string;
}

const QUICK_PROMPTS = [
  'مين أكتر جهاز سحب باقة النهاردة وهل السحب محلي ولا إنترنت؟',
  'إيه حالة خطين WAN1 و WAN2 حالياً وهل فيه أي تنبيهات؟',
  'وريني الأجهزة اللي على تردد 2.4GHz وإشارتها ضعيفة',
  'هل حصلت أي انقطاعات أو هجمات خلال آخر ٢٤ ساعة؟',
];

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToInt16Array(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function TendaCopilotDrawer() {
  const pathname = usePathname();
  const { mutate: globalMutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [expandedSql, setExpandedSql] = useState<Record<string, boolean>>({});
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedResults, setAppliedResults] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  // Live Voice Operator state (`gemini-3.8-live`)
  const [liveState, setLiveState] = useState<'idle' | 'connecting' | 'listening' | 'speaking'>('idle');
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveSessionRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isAuthPage = pathname === '/login' || pathname === '/setup';

  const focusedMac = useMemo(() => {
    if (!pathname?.startsWith('/devices/')) return null;
    const raw = pathname.slice('/devices/'.length).split('/')[0];
    return raw ? decodeURIComponent(raw) : null;
  }, [pathname]);

  const stopLiveVoice = useCallback(() => {
    try {
      liveSessionRef.current?.close?.();
    } catch {}
    liveSessionRef.current = null;

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {}
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) track.stop();
      micStreamRef.current = null;
    }
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {}
    }
    activeSourcesRef.current = [];
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    nextPlayTimeRef.current = 0;
    setLiveState('idle');
  }, []);

  // Keyboard shortcut Cmd+K / Ctrl+K + Custom event from TopNav
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    const onCustomOpen = (e: Event) => {
      setOpen(true);
      const custom = e as CustomEvent<{ prompt?: string }>;
      if (custom.detail?.prompt) {
        setInput(custom.detail.prompt);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('tenda:open-copilot', onCustomOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('tenda:open-copilot', onCustomOpen);
    };
  }, [open]);

  useEffect(() => {
    if (!open && liveState !== 'idle') {
      stopLiveVoice();
    }
  }, [open, liveState, stopLiveVoice]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending, liveState]);

  const sendPrompt = async (textOverride?: string) => {
    const clean = (textOverride ?? input).trim();
    if (!clean || sending) return;
    if (!textOverride) setInput('');

    const userMsg: ChatItem = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: clean,
    };
    const historyPayload = messages.slice(-8).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);

    try {
      const resp = await fetch('/api/ai/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: clean,
          history: historyPayload,
          pageContext: { pathname, focusedMac },
        }),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'model',
            content: json?.error || 'تعذّر إتمام المحادثة حالياً.',
          },
        ]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `m-${Date.now()}`,
          role: 'model',
          content: String(json.replyAr || ''),
          sqlQueriesRun: Array.isArray(json.sqlQueriesRun) ? json.sqlQueriesRun : [],
          proposedActions: Array.isArray(json.proposedActions) ? json.proposedActions : [],
          modelUsed: json.modelUsed,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'model',
          content: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const applyProposedAction = async (act: ProposedActionClient) => {
    setApplyingId(act.id);
    setActionErrors((s) => ({ ...s, [act.id]: '' }));
    try {
      const resp = await fetch('/api/ai/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(act),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        setActionErrors((s) => ({ ...s, [act.id]: json?.error || 'فشل تطبيق الإجراء.' }));
        return;
      }
      setAppliedResults((s) => ({ ...s, [act.id]: json.summaryAr || 'تم التنفيذ بنجاح.' }));
      await Promise.all([
        globalMutate('/api/devices?live=1'),
        globalMutate('/api/network-control'),
        globalMutate('/api/alerts'),
        globalMutate('/api/status'),
      ]);
    } catch (e) {
      setActionErrors((s) => ({ ...s, [act.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setApplyingId(null);
    }
  };

  const playPcm24kChunk = (base64Pcm: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const pcm16 = base64ToInt16Array(base64Pcm);
    if (pcm16.length === 0) return;
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i]! / 32768;
    }
    const audioBuf = ctx.createBuffer(1, float32.length, 24000);
    audioBuf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    src.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuf.duration;
    activeSourcesRef.current.push(src);
    setLiveState('speaking');
    src.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((x) => x !== src);
      if (activeSourcesRef.current.length === 0 && liveSessionRef.current) {
        setLiveState('listening');
      }
    };
  };

  const startLiveVoice = async () => {
    setLiveError(null);
    setLiveState('connecting');
    try {
      const tokResp = await fetch('/api/ai/live-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const tokJson = await tokResp.json().catch(() => null);
      if (!tokResp.ok || !tokJson?.ok) {
        setLiveError(tokJson?.error || 'تعذّر بدء الجلسة الصوتية الحية.');
        setLiveState('idle');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      nextPlayTimeRef.current = audioCtx.currentTime;

      const ai = new GoogleGenAI({
        apiKey: tokJson.token,
        httpOptions: { apiVersion: 'v1alpha' },
      });

      const session = await ai.live.connect({
        model: tokJson.model || 'gemini-3.8-live',
        config: {
          responseModalities: ['AUDIO' as any],
          systemInstruction: { parts: [{ text: tokJson.systemInstruction }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'query_network_sqlite',
                  behavior: 'NON_BLOCKING' as any,
                  description: 'Run a read-only SQLite SELECT query on tenda.db using DEV_XX tokens.',
                  parameters: {
                    type: 'OBJECT' as any,
                    properties: {
                      sql: { type: 'STRING' as any, description: 'Read-only SELECT query' },
                    },
                    required: ['sql'],
                  },
                },
                {
                  name: 'propose_router_action',
                  behavior: 'NON_BLOCKING' as any,
                  description: 'Queue a router QoS, WAN1/WAN2, or DHCP confirmation card for the owner.',
                  parameters: {
                    type: 'OBJECT' as any,
                    properties: {
                      kind: {
                        type: 'STRING' as any,
                        enum: ['set_qos', 'move_wan', 'reserve_dhcp', 'dismiss_alert'],
                      },
                      label_ar: { type: 'STRING' as any },
                      mac_token: { type: 'STRING' as any },
                      download_limit_kbs: { type: 'NUMBER' as any },
                      upload_limit_kbs: { type: 'NUMBER' as any },
                      wan_port: { type: 'NUMBER' as any },
                    },
                    required: ['kind', 'label_ar'],
                  },
                },
              ],
            },
          ],
        },
        callbacks: {
          onopen: () => {
            setLiveState('listening');
          },
          onmessage: async (msg: any) => {
            if (msg?.serverContent?.interrupted) {
              for (const s of activeSourcesRef.current) {
                try {
                  s.stop();
                } catch {}
              }
              activeSourcesRef.current = [];
              if (audioCtxRef.current) nextPlayTimeRef.current = audioCtxRef.current.currentTime;
            }

            const parts = msg?.serverContent?.modelTurn?.parts ?? [];
            for (const p of parts) {
              if (p?.inlineData?.data && String(p.inlineData.mimeType || '').startsWith('audio/pcm')) {
                playPcm24kChunk(p.inlineData.data);
              }
            }

            const inText = msg?.serverContent?.inputTranscription?.text;
            if (typeof inText === 'string' && inText.trim()) {
              setMessages((prev) => [
                ...prev,
                { id: `vu-${Date.now()}-${Math.random()}`, role: 'user', content: `🎙️ ${inText.trim()}` },
              ]);
            }

            const outText = msg?.serverContent?.outputTranscription?.text;
            if (typeof outText === 'string' && outText.trim()) {
              setMessages((prev) => [
                ...prev,
                {
                  id: `vm-${Date.now()}-${Math.random()}`,
                  role: 'model',
                  content: outText.trim(),
                  modelUsed: 'gemini-3.8-live',
                },
              ]);
            }

            const fnCalls = msg?.toolCall?.functionCalls;
            if (Array.isArray(fnCalls) && fnCalls.length > 0) {
              const responses: any[] = [];
              for (const fc of fnCalls) {
                try {
                  const r = await fetch('/api/ai/live-tool', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: fc.name, args: fc.args ?? {} }),
                  });
                  const j = await r.json().catch(() => ({ ok: false }));
                  if (j?.proposedAction) {
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: `va-${Date.now()}-${Math.random()}`,
                        role: 'model',
                        content: 'إجراء مقترح جاهز للتنفيذ بضغطة زر:',
                        proposedActions: [j.proposedAction as ProposedActionClient],
                        modelUsed: 'gemini-3.8-live',
                      },
                    ]);
                  }
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: j?.result ?? { error: j?.error || 'Tool error' },
                  });
                } catch (err) {
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { error: String(err) },
                  });
                }
              }
              session.sendToolResponse({ functionResponses: responses });
            }
          },
          onerror: (err: any) => {
            setLiveError(err?.message || 'انقطع اتصال الصوت الحي.');
            stopLiveVoice();
          },
          onclose: () => {
            stopLiveVoice();
          },
        },
      });

      liveSessionRef.current = session;

      const sourceNode = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (ev) => {
        if (!liveSessionRef.current) return;
        const inputData = ev.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]!));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        liveSessionRef.current.sendRealtimeInput({
          audio: {
            data: arrayBufferToBase64(pcm16.buffer),
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      };
      sourceNode.connect(processor);
      processor.connect(audioCtx.destination);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
      stopLiveVoice();
    }
  };

  if (isAuthPage || !open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={() => setOpen(false)}
      />

      {/* Drawer Panel */}
      <aside
        dir="rtl"
        aria-label="Tenda AI Copilot"
        className="relative z-10 w-full max-w-lg h-full flex flex-col"
        style={{
          background: '#111114',
          boxShadow: '-24px 0 60px rgba(0,0,0,.55), inset 1px 0 0 rgba(255,255,255,.08)',
        }}
      >
        {/* Header */}
        <div
          className="px-4 py-3.5 flex items-center justify-between gap-3"
          style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: 'rgba(91,141,239,.14)',
                boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.35)',
              }}
            >
              <Sparkles size={15} style={{ color: '#8bb2ff' }} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold flex items-center gap-2" style={{ color: '#f7f8f8' }}>
                <span>مساعد الشبكة الذكي</span>
                <span
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium"
                  style={{
                    background: 'rgba(255,255,255,.05)',
                    color: 'rgba(180,188,208,.75)',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.08)',
                  }}
                >
                  <bdi>Zero-PII</bdi>
                </span>
              </div>
              <div className="text-[11px] truncate" style={{ color: 'rgba(180,188,208,.6)' }}>
                استعلام <bdi>SQLite</bdi> مباشر + تحكم آمن بالراوتر
                {focusedMac && (
                  <>
                    {' · '}الجهاز الحالي: <bdi className="font-mono">{focusedMac.slice(-8)}</bdi>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => (liveState === 'idle' ? void startLiveVoice() : stopLiveVoice())}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition"
              style={
                liveState !== 'idle'
                  ? {
                      background: 'rgba(244,103,107,.14)',
                      color: '#f4676b',
                      boxShadow: 'inset 0 0 0 1px rgba(244,103,107,.35)',
                    }
                  : {
                      background: 'rgba(91,141,239,.12)',
                      color: '#8bb2ff',
                      boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.32)',
                    }
              }
              title="التحدث المباشر عبر Gemini 3.8 Live"
            >
              {liveState === 'connecting' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : liveState !== 'idle' ? (
                <MicOff size={13} />
              ) : (
                <Mic size={13} />
              )}
              <span>
                {liveState === 'connecting'
                  ? 'يتصل...'
                  : liveState === 'listening'
                  ? 'يستمع...'
                  : liveState === 'speaking'
                  ? 'يتحدث...'
                  : 'صوت حي'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1.5 rounded-lg hover:bg-white/5 transition"
              style={{ color: 'rgba(180,188,208,.75)' }}
              aria-label="إغلاق"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {liveError && (
          <div
            className="mx-4 mt-3 rounded-lg px-3 py-2 text-xs"
            style={{
              background: 'rgba(244,103,107,.09)',
              color: '#f4676b',
              boxShadow: 'inset 0 0 0 1px rgba(244,103,107,.30)',
            }}
          >
            {liveError}
          </div>
        )}

        {/* Messages Body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="space-y-3 py-4">
              <div
                className="rounded-xl p-4 space-y-2"
                style={{ background: '#17171b', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
              >
                <div className="text-sm font-semibold" style={{ color: '#f7f8f8' }}>
                  اسأل بأي صيغة بالعربية أو الإنجليزية
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'rgba(180,188,208,.75)', lineHeight: 1.6 }}>
                  يستعلم المساعد مباشرة من جداول <bdi>samples_raw</bdi> و <bdi>wan_samples</bdi> و{' '}
                  <bdi>traffic_hour</bdi> بدون إرسال أي عنوان <bdi>MAC</bdi> أو <bdi>IP</bdi> خارج جهازك، ويقترح أزرار تعديل سرعة أو توجيه <bdi>WAN1/WAN2</bdi> لتعتمدها بنفسك.
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium" style={{ color: 'rgba(180,188,208,.55)' }}>
                  أسئلة سريعة جاهزة:
                </div>
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void sendPrompt(q)}
                    className="w-full text-right rounded-lg px-3 py-2.5 text-xs transition hover:bg-white/5"
                    style={{
                      background: '#17171b',
                      color: 'rgba(247,248,248,.9)',
                      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => {
            const isUser = m.role === 'user';
            const sqlOpen = Boolean(expandedSql[m.id]);
            return (
              <div
                key={m.id}
                className={`flex flex-col ${isUser ? 'items-start' : 'items-stretch'}`}
              >
                <div
                  className="rounded-xl px-3.5 py-2.5 text-[14px] space-y-2.5 max-w-full"
                  style={
                    isUser
                      ? {
                          background: 'rgba(91,141,239,.14)',
                          color: '#f7f8f8',
                          boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.32)',
                        }
                      : {
                          background: '#17171b',
                          color: '#f7f8f8',
                          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.07)',
                        }
                  }
                >
                  <div className="whitespace-pre-wrap leading-relaxed" style={{ lineHeight: 1.6 }} dir="auto">
                    {m.content}
                  </div>

                  {/* SQL Transparency Toggle */}
                  {m.sqlQueriesRun && m.sqlQueriesRun.length > 0 && (
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => setExpandedSql((s) => ({ ...s, [m.id]: !s[m.id] }))}
                        className="inline-flex items-center gap-1 text-[11px] font-medium"
                        style={{ color: 'rgba(180,188,208,.65)' }}
                      >
                        <Database size={11} />
                        <span>
                          نفّذ <span className="tabular-nums">{m.sqlQueriesRun.length}</span> استعلام قراءة فقط
                        </span>
                        {sqlOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      {sqlOpen && (
                        <div className="mt-1.5 space-y-1.5" dir="ltr">
                          {m.sqlQueriesRun.map((sql, idx) => (
                            <pre
                              key={idx}
                              className="rounded p-2 text-[11px] font-mono overflow-x-auto"
                              style={{
                                background: '#0a0a0c',
                                color: 'rgba(180,188,208,.85)',
                                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
                              }}
                            >
                              {sql}
                            </pre>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Proposed Human-in-the-Loop Router Actions */}
                  {m.proposedActions && m.proposedActions.length > 0 && (
                    <div className="space-y-2 pt-1">
                      {m.proposedActions.map((act) => {
                        const doneText = appliedResults[act.id];
                        const errText = actionErrors[act.id];
                        const busy = applyingId === act.id;
                        return (
                          <div
                            key={act.id}
                            className="rounded-lg p-2.5 flex items-center justify-between gap-2 flex-wrap"
                            style={{
                              background: '#1e1e24',
                              boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.28)',
                            }}
                          >
                            <div className="text-xs space-y-0.5">
                              <div className="font-medium" style={{ color: '#f7f8f8' }}>
                                {act.labelAr}
                              </div>
                              {act.deviceLabel && (
                                <div style={{ color: 'rgba(180,188,208,.65)' }}>
                                  الجهاز: <bdi>{act.deviceLabel}</bdi>
                                </div>
                              )}
                              {errText && <div style={{ color: '#f4676b' }}>{errText}</div>}
                            </div>

                            {doneText ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs font-medium"
                                style={{ color: '#3fb27f' }}
                              >
                                <Check size={13} />
                                <span>{doneText}</span>
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void applyProposedAction(act)}
                                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
                                style={{
                                  background: '#5b8def',
                                  color: '#0a0a0c',
                                }}
                              >
                                {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                                <span>تأكيد وتنفيذ</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {sending && (
            <div
              className="rounded-xl px-3.5 py-2.5 text-xs flex items-center gap-2"
              style={{
                background: '#17171b',
                color: 'rgba(180,188,208,.75)',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
              }}
            >
              <Loader2 size={13} className="animate-spin" />
              <span>يستعلم من قاعدة البيانات ويحلل القراءات...</span>
            </div>
          )}
        </div>

        {/* Input Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendPrompt();
          }}
          className="p-3.5 flex items-center gap-2"
          style={{ borderTop: '1px solid rgba(255,255,255,.07)' }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="اسأل عن جهاز، سرعة، باقة، أو اطلب تعديل QoS / WAN..."
            className="flex-1 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none"
            style={{
              background: '#17171b',
              color: '#f7f8f8',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="rounded-xl px-3.5 py-2.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 transition"
            style={{
              background: '#5b8def',
              color: '#0a0a0c',
            }}
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            <span>إرسال</span>
          </button>
        </form>
      </aside>
    </div>
  );
}
