'use client';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { Cpu, MemoryStick, Globe, Activity } from 'lucide-react';
import { formatBytes, formatBps } from '../lib/format';

interface Telemetry {
  ts: number;
  sysInfo: { cpuUsage?: number; memUsage?: number; firmware?: string; model?: string; raw: Record<string, any> };
  wanFlow: Array<Record<string, any>>;
}

function getNum(o: Record<string, any> | undefined, ...keys: string[]): number | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function toneFor(pct: number | undefined): string {
  if (pct === undefined) return 'text-slate-400';
  if (pct > 80) return 'text-accent-red';
  if (pct > 50) return 'text-accent-amber';
  return 'text-accent-green';
}

function gradientFor(pct: number | undefined): string {
  if (pct === undefined) return 'from-slate-600 to-slate-700';
  if (pct > 80) return 'from-rose-500 to-rose-600';
  if (pct > 50) return 'from-amber-500 to-amber-600';
  return 'from-emerald-500 to-emerald-600';
}

export function TelemetryBar() {
  const { data } = useSWR<{ telemetry: Telemetry | null }>('/api/telemetry', fetcher, { refreshInterval: 10000 });
  const t = data?.telemetry;
  if (!t) return null;

  const cpu = t.sysInfo.cpuUsage;
  const mem = t.sysInfo.memUsage;
  const wans = t.wanFlow;

  return (
    <div className="card px-3 sm:px-4 py-2.5 sm:py-3 animate-fade-in mb-4 sm:mb-5">
      <div className="flex items-center gap-3 sm:gap-5 flex-wrap">
        {/* Identity */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500/30 to-blue-700/10 ring-1 ring-blue-500/30 flex items-center justify-center">
            <Activity size={13} className="text-blue-300" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold leading-none">Router</div>
            <div className="text-xs text-slate-200 font-medium leading-tight mt-0.5 truncate">
              {t.sysInfo.model || 'Tenda'} <span className="text-slate-500 font-normal">· {t.sysInfo.firmware || '?'}</span>
            </div>
          </div>
        </div>

        <div className="hidden sm:block w-px h-8 bg-bg-border/60" />

        {/* CPU */}
        <div className="flex items-center gap-2 shrink-0">
          <Cpu size={12} className="text-slate-500" />
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold leading-none">CPU</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className={`text-sm font-bold tabular-nums ${toneFor(cpu)}`}>
                {cpu !== undefined ? `${cpu.toFixed(0)}%` : '—'}
              </span>
              {cpu !== undefined && (
                <div className="w-12 sm:w-16 h-1 bg-bg-border rounded overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r ${gradientFor(cpu)}`}
                    style={{ width: `${Math.min(100, cpu)}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Memory */}
        <div className="flex items-center gap-2 shrink-0">
          <MemoryStick size={12} className="text-slate-500" />
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold leading-none">Memory</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className={`text-sm font-bold tabular-nums ${toneFor(mem)}`}>
                {mem !== undefined ? `${mem.toFixed(0)}%` : '—'}
              </span>
              {mem !== undefined && (
                <div className="w-12 sm:w-16 h-1 bg-bg-border rounded overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r ${gradientFor(mem)}`}
                    style={{ width: `${Math.min(100, mem)}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* WAN flow */}
        {wans.length > 0 && (
          <>
            <div className="hidden md:block w-px h-8 bg-bg-border/60" />
            <div className="flex items-center gap-3 sm:gap-4 shrink-0 flex-wrap">
              {wans.map((w, i) => {
                const dlMB = getNum(w, 'FlowDownstream', 'downMB');
                const ulMB = getNum(w, 'FlowUpstream', 'upMB');
                const dlBytes = dlMB !== undefined ? dlMB * 1024 * 1024 : getNum(w, 'downBytes', 'rxBytes');
                const ulBytes = ulMB !== undefined ? ulMB * 1024 * 1024 : getNum(w, 'upBytes', 'txBytes');
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Globe size={12} className="text-slate-500" />
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold leading-none">WAN {i + 1}</div>
                      <div className="flex items-baseline gap-1.5 mt-0.5 text-xs tabular-nums">
                        <span className="text-blue-400">↓ {dlBytes !== undefined ? formatBytes(dlBytes, 0) : '—'}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-orange-400">↑ {ulBytes !== undefined ? formatBytes(ulBytes, 0) : '—'}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="ml-auto text-[10px] text-slate-500 tabular-nums shrink-0">
          {Math.round((Date.now() - t.ts) / 1000)}s
        </div>
      </div>
    </div>
  );
}
