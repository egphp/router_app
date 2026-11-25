'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Check, Loader2, RefreshCw, Sparkles, Play } from 'lucide-react';

export interface ProposedActionClient {
  id: string;
  kind: 'set_qos' | 'move_wan' | 'reserve_dhcp' | 'dismiss_alert' | 'rename_device';
  labelAr: string;
  mac?: string;
  deviceLabel?: string;
  ip?: string | null;
  downloadLimitKbs?: number;
  uploadLimitKbs?: number;
  wanPort?: 1 | 2 | 'WAN1' | 'WAN2';
  dhcpReserved?: boolean;
  alertId?: number;
  newCustomLabel?: string;
}

interface ExplanationPayload {
  scopeType: string;
  scopeKey: string;
  verdict: 'benign' | 'watch' | 'action_needed' | 'info';
  lanOrWan: 'lan_only' | 'wan1' | 'wan2' | 'mixed' | null;
  titleAr: string;
  explanationAr: string;
  recommendedAction: ProposedActionClient | null;
  modelUsed: string;
  cached: boolean;
}

export function AskGeminiButton({
  scopeType,
  scopeKey,
  contextPayload,
  compact = false,
  label = 'اسأل Gemini',
}: {
  scopeType:
    | 'alert'
    | 'security'
    | 'attack'
    | 'outage'
    | 'anomaly'
    | 'wan_advisor'
    | 'wifi_map'
    | 'integrity_watchdog';
  scopeKey: string;
  contextPayload: Record<string, unknown>;
  compact?: boolean;
  label?: string;
}) {
  const { mutate: globalMutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [data, setData] = useState<ExplanationPayload | null>(null);

  const loadExplanation = async (forceRefresh = false) => {
    setLoading(true);
    setErrMsg(null);
    setOpen(true);
    try {
      const resp = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopeType, scopeKey, contextPayload, forceRefresh }),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        setErrMsg(json?.error || 'تعذّر جلب التحليل حالياً.');
        return;
      }
      setData(json.explanation as ExplanationPayload);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const applyAction = async (action: ProposedActionClient) => {
    setApplying(true);
    setErrMsg(null);
    try {
      const resp = await fetch('/api/ai/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        setErrMsg(json?.error || 'تعذّر تطبيق الإجراء على الراوتر.');
        return;
      }
      setAppliedMsg(json.summaryAr || 'تم تنفيذ الإجراء بنجاح.');
      await Promise.all([
        globalMutate('/api/alerts'),
        globalMutate('/api/devices?live=1'),
        globalMutate('/api/network-control'),
        globalMutate('/api/status'),
      ]);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const verdictStyle =
    data?.verdict === 'action_needed'
      ? {
          bg: 'rgba(244,103,107,.09)',
          text: '#f4676b',
          ring: 'inset 0 0 0 1px rgba(244,103,107,.30)',
          label: 'يستدعي إجراء',
        }
      : data?.verdict === 'watch'
      ? {
          bg: 'rgba(227,160,8,.09)',
          text: '#e3a008',
          ring: 'inset 0 0 0 1px rgba(227,160,8,.28)',
          label: 'للمتابعة',
        }
      : data?.verdict === 'benign'
      ? {
          bg: 'rgba(63,178,127,.10)',
          text: '#3fb27f',
          ring: 'inset 0 0 0 1px rgba(63,178,127,.28)',
          label: 'طبيعي / آمن',
        }
      : {
          bg: 'rgba(91,141,239,.10)',
          text: '#5b8def',
          ring: 'inset 0 0 0 1px rgba(91,141,239,.32)',
          label: 'معلومة تشغيلية',
        };

  return (
    <div className="inline-flex flex-col items-start gap-2 max-w-full" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open && data) {
            setOpen(false);
          } else {
            void loadExplanation(false);
          }
        }}
        disabled={loading}
        className={`inline-flex items-center gap-1.5 rounded-lg font-medium transition ${
          compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-xs'
        }`}
        style={{
          background: 'rgba(91,141,239,.10)',
          color: '#8bb2ff',
          boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.32)',
        }}
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        <span>{label}</span>
      </button>

      {open && (
        <div
          dir="rtl"
          className="w-full min-w-[260px] sm:min-w-[340px] rounded-xl p-3.5 text-right space-y-2.5"
          style={{
            background: '#17171b',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.08)',
          }}
        >
          {loading && !data ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: 'rgba(180,188,208,.75)' }}>
              <Loader2 size={13} className="animate-spin" />
              <span>جارٍ فحص بيانات الراوتر بتعمية كاملة للهوية...</span>
            </div>
          ) : errMsg ? (
            <div className="text-xs" style={{ color: '#f4676b' }}>
              {errMsg}
            </div>
          ) : data ? (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className="rounded px-2 py-0.5 text-xs font-medium"
                    style={{
                      background: verdictStyle.bg,
                      color: verdictStyle.text,
                      boxShadow: verdictStyle.ring,
                    }}
                  >
                    {verdictStyle.label}
                  </span>
                  {data.lanOrWan && (
                    <span
                      className="rounded px-2 py-0.5 text-xs font-medium"
                      style={{
                        background: 'rgba(255,255,255,.05)',
                        color: 'rgba(180,188,208,.85)',
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                      }}
                    >
                      <bdi>
                        {data.lanOrWan === 'lan_only'
                          ? 'LAN-Only'
                          : data.lanOrWan === 'wan1'
                          ? 'WAN1'
                          : data.lanOrWan === 'wan2'
                          ? 'WAN2'
                          : 'LAN+WAN'}
                      </bdi>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'rgba(180,188,208,.55)' }}>
                  <bdi>{data.modelUsed}</bdi>
                  <button
                    type="button"
                    onClick={() => void loadExplanation(true)}
                    disabled={loading}
                    title="إعادة التحديث"
                    className="p-1 rounded hover:bg-white/5 transition"
                  >
                    <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>

              <div className="text-sm font-semibold" style={{ color: '#f7f8f8' }} dir="auto">
                {data.titleAr}
              </div>
              <p
                className="text-[13px] leading-relaxed font-normal"
                style={{ color: 'rgba(180,188,208,.85)', lineHeight: 1.6 }}
                dir="auto"
              >
                {data.explanationAr}
              </p>

              {data.recommendedAction && (
                <div className="pt-1 flex items-center justify-between gap-2 flex-wrap">
                  {appliedMsg ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: '#3fb27f' }}>
                      <Check size={13} />
                      <span>{appliedMsg}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={applying}
                      onClick={() => void applyAction(data.recommendedAction!)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
                      style={{
                        background: 'rgba(91,141,239,.14)',
                        color: '#8bb2ff',
                        boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.35)',
                      }}
                    >
                      {applying ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      <span>{data.recommendedAction.labelAr}</span>
                    </button>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
