'use client';

import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { AlertTriangle, Check, Gauge, Loader2, Play, Sparkles } from 'lucide-react';
import { fetcher } from '../lib/fetcher';
import { formatBytes } from '../lib/format';
import type { ProposedActionClient } from './AskGeminiButton';

interface QuotaWanForecastItem {
  wanId: 1 | 2;
  quotaBytes: number;
  usedBytesCycle: number;
  dailyBurnBytesWeighted: number;
  projectedCycleBytes: number;
  daysUntilExhaustion: number | null;
  willExhaustBeforeRenewal: boolean;
  daysShortfall: number;
}

interface QuotaForecastPayload {
  cycleStartTs: number;
  cycleEndTs: number;
  daysElapsed: number;
  daysRemainingInCycle: number;
  renewalDay: number;
  networkUsedTotalBytes: number;
  weightedDailyBurnBytes: number;
  projectedCycleTotalBytes: number;
  combinedQuotaBytes: number;
  daysUntilCombinedExhaustion: number | null;
  willExhaustBeforeRenewal: boolean;
  potentialHdCapSavingsBytes: number;
  wans: QuotaWanForecastItem[];
  topConsumers: Array<{
    mac: string;
    label: string;
    category: string | null;
    totalBytes: number;
    sharePct: number;
  }>;
  summaryAr: string;
  recommendedActions: ProposedActionClient[];
}

export function QuotaForecastCard() {
  const { mutate: globalMutate } = useSWRConfig();
  const { data, mutate } = useSWR<{ ok: boolean; forecast: QuotaForecastPayload }>(
    '/api/ai/quota-forecast',
    fetcher,
    { refreshInterval: 60_000 },
  );
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedText, setAppliedText] = useState<string | null>(null);
  const [errText, setErrText] = useState<string | null>(null);

  const f = data?.forecast;
  if (!f) return null;

  const combinedQuotaBytes = f.combinedQuotaBytes;
  const combinedPct =
    combinedQuotaBytes > 0 ? Math.min(100, (f.networkUsedTotalBytes / combinedQuotaBytes) * 100) : 0;
  const projectedPct =
    combinedQuotaBytes > 0 ? Math.min(100, (f.projectedCycleTotalBytes / combinedQuotaBytes) * 100) : 0;
  const primaryAction = f.recommendedActions?.[0] ?? null;

  const applySuggested = async (act: ProposedActionClient) => {
    setApplyingId(act.id);
    setErrText(null);
    try {
      const resp = await fetch('/api/ai/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(act),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        setErrText(json?.error || 'تعذّر تطبيق الإجراء على الراوتر.');
        return;
      }
      setAppliedText(json.summaryAr || 'تم تفعيل حد التوفير بنجاح.');
      await Promise.all([mutate(), globalMutate('/api/devices?live=1'), globalMutate('/api/network-control')]);
    } catch (e) {
      setErrText(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div
      dir="rtl"
      className="card p-4 sm:p-5 animate-fade-in space-y-4"
      style={{
        boxShadow: f.willExhaustBeforeRenewal
          ? 'inset 0 0 0 1px rgba(227,160,8,.32)'
          : 'inset 0 0 0 1px rgba(255,255,255,.06)',
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles size={15} style={{ color: f.willExhaustBeforeRenewal ? '#e3a008' : '#5b8def' }} />
            <h2 className="text-[15px] font-semibold" style={{ color: '#f7f8f8' }}>
              التنبؤ الذكي بباقة الإنترنت ومعدل الحرق اليومي
            </h2>
          </div>
          <p className="text-xs font-normal" style={{ color: 'rgba(180,188,208,.75)' }}>
            باقي في الدورة <span className="tabular-nums font-medium">{f.daysRemainingInCycle}</span> يوم · معدل السحب المرجّح{' '}
            <bdi className="tabular-nums font-medium">{formatBytes(f.weightedDailyBurnBytes)}/day</bdi>
          </p>
        </div>

        {f.willExhaustBeforeRenewal ? (
          <span
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium"
            style={{
              background: 'rgba(227,160,8,.09)',
              color: '#e3a008',
              boxShadow: 'inset 0 0 0 1px rgba(227,160,8,.28)',
            }}
          >
            <AlertTriangle size={13} />
            <span>متوقع نفاد الباقة قبل التجديد</span>
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium"
            style={{
              background: 'rgba(255,255,255,.04)',
              color: 'rgba(180,188,208,.75)',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.08)',
            }}
          >
            <Gauge size={13} />
            <span>معدل السحب ضمن حدود الباقة</span>
          </span>
        )}
      </div>

      {/* Primary KPI + Linear Progress Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div
          className="rounded-xl p-3.5 space-y-2"
          style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium" style={{ color: 'rgba(180,188,208,.75)' }}>
              إجمالي الدورة حتى الآن
            </span>
            <span className="text-xs tabular-nums" style={{ color: 'rgba(180,188,208,.55)' }}>
              من أصل <bdi>{formatBytes(combinedQuotaBytes, 0)}</bdi>
            </span>
          </div>
          <div className="text-2xl font-semibold tabular-nums" style={{ color: '#f7f8f8' }}>
            <bdi>{formatBytes(f.networkUsedTotalBytes)}</bdi>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.06)' }}>
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-linear"
              style={{
                width: `${combinedPct}%`,
                background: f.willExhaustBeforeRenewal ? '#e3a008' : '#5b8def',
              }}
            />
          </div>
          <div className="text-xs tabular-nums" style={{ color: 'rgba(180,188,208,.65)' }}>
            المتوقع بنهاية الشهر: <bdi>{formatBytes(f.projectedCycleTotalBytes)}</bdi> ({projectedPct.toFixed(0)}%)
          </div>
        </div>

        {(f.wans ?? []).map((w) => {
          const pct = w.quotaBytes > 0 ? Math.min(100, (w.usedBytesCycle / w.quotaBytes) * 100) : 0;
          return (
            <div
              key={w.wanId}
              className="rounded-xl p-3.5 space-y-2"
              style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold" style={{ color: '#f7f8f8' }}>
                  خط <bdi>WAN{w.wanId}</bdi>
                </span>
                <span className="text-xs tabular-nums" style={{ color: 'rgba(180,188,208,.65)' }}>
                  سعة <bdi>{formatBytes(w.quotaBytes, 0)}</bdi>
                </span>
              </div>
              <div className="text-xl font-semibold tabular-nums" style={{ color: '#f7f8f8' }}>
                <bdi>{formatBytes(w.usedBytesCycle)}</bdi>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.06)' }}>
                <div
                  className="h-full rounded-full transition-[width] duration-300 ease-linear"
                  style={{
                    width: `${pct}%`,
                    background: w.willExhaustBeforeRenewal ? '#f4676b' : 'rgba(180,188,208,.55)',
                  }}
                />
              </div>
              <div className="text-xs tabular-nums" style={{ color: 'rgba(180,188,208,.65)' }}>
                {w.daysUntilExhaustion !== null && w.willExhaustBeforeRenewal ? (
                  <span style={{ color: '#f4676b' }}>
                    يكفي حوالي {w.daysUntilExhaustion.toFixed(1)} يوم بالمعدل الحالي
                  </span>
                ) : (
                  <span>
                    معدل يومي <bdi>{formatBytes(w.dailyBurnBytesWeighted)}</bdi>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Top Consumers + One-Click Action */}
      {(f.topConsumers.length > 0 || f.summaryAr) && (
        <div
          className="rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
        >
          <div className="space-y-1 text-xs" style={{ color: 'rgba(180,188,208,.85)' }}>
            <div className="font-medium" style={{ color: '#f7f8f8' }} dir="auto">
              {f.summaryAr}
            </div>
            {f.topConsumers.length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {f.topConsumers.slice(0, 3).map((c) => (
                  <span key={c.mac} className="tabular-nums">
                    <bdi className="font-medium" style={{ color: '#f7f8f8' }}>
                      {c.label}
                    </bdi>{' '}
                    · <bdi>{formatBytes(c.totalBytes)}</bdi> ({c.sharePct}%)
                  </span>
                ))}
                {f.potentialHdCapSavingsBytes > 1024 ** 3 && (
                  <span style={{ color: '#8bb2ff' }}>
                    توفير متوقع عند تحديد HD: ~<bdi>{formatBytes(f.potentialHdCapSavingsBytes)}</bdi>
                  </span>
                )}
              </div>
            )}
            {errText && <div style={{ color: '#f4676b' }}>{errText}</div>}
          </div>

          {primaryAction && (
            <div className="shrink-0">
              {appliedText ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: '#3fb27f' }}>
                  <Check size={14} />
                  <span>{appliedText}</span>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={applyingId !== null}
                  onClick={() => void applySuggested(primaryAction)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition disabled:opacity-50"
                  style={{
                    background: 'rgba(91,141,239,.14)',
                    color: '#8bb2ff',
                    boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.35)',
                  }}
                >
                  {applyingId === primaryAction.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  <span>{primaryAction.labelAr}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
