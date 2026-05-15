'use client';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { Cpu, MemoryStick, Globe } from 'lucide-react';
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

export function TelemetryCard() {
  const { data } = useSWR<{ telemetry: Telemetry | null }>('/api/telemetry', fetcher, { refreshInterval: 10000 });
  const t = data?.telemetry;

  if (!t) return null;

  const cpu = t.sysInfo.cpuUsage;
  const mem = t.sysInfo.memUsage;
  const wans = t.wanFlow;

  return (
    <div className="card p-4 sm:p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="stat-label">Router telemetry</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {t.sysInfo.model || 'Tenda router'} · fw {t.sysInfo.firmware || '?'}
          </div>
        </div>
        <div className="text-[10px] text-slate-500">updated {Math.round((Date.now() - t.ts) / 1000)}s ago</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* CPU */}
        <div className="bg-bg-elevated/60 rounded-md p-3">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wide">
            <Cpu size={11} /> CPU
          </div>
          <div className="text-xl font-bold mt-1 tabular-nums">
            {cpu !== undefined ? `${cpu.toFixed(0)}%` : '—'}
          </div>
          {cpu !== undefined && (
            <div className="h-1 bg-bg-border rounded mt-1.5 overflow-hidden">
              <div
                className={`h-full ${cpu > 80 ? 'bg-accent-red' : cpu > 50 ? 'bg-accent-amber' : 'bg-accent-green'}`}
                style={{ width: `${Math.min(100, cpu)}%` }}
              />
            </div>
          )}
        </div>

        {/* Memory */}
        <div className="bg-bg-elevated/60 rounded-md p-3">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wide">
            <MemoryStick size={11} /> Memory
          </div>
          <div className="text-xl font-bold mt-1 tabular-nums">
            {mem !== undefined ? `${mem.toFixed(0)}%` : '—'}
          </div>
          {mem !== undefined && (
            <div className="h-1 bg-bg-border rounded mt-1.5 overflow-hidden">
              <div
                className={`h-full ${mem > 80 ? 'bg-accent-red' : mem > 50 ? 'bg-accent-amber' : 'bg-accent-green'}`}
                style={{ width: `${Math.min(100, mem)}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {wans.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 uppercase tracking-wide">
            <Globe size={11} /> WAN flow ({wans.length} interface{wans.length === 1 ? '' : 's'})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {wans.map((w, i) => {
              const totalDown = getNum(w, 'downBytes', 'downloadBytes', 'rxBytes', 'totalDown', 'downByte');
              const totalUp = getNum(w, 'upBytes', 'uploadBytes', 'txBytes', 'totalUp', 'upByte');
              const speedDown = getNum(w, 'downSpeed', 'rxSpeed', 'downBps');
              const speedUp = getNum(w, 'upSpeed', 'txSpeed', 'upBps');
              return (
                <div key={i} className="bg-bg-elevated/40 rounded-md p-2.5 text-xs">
                  <div className="font-semibold text-slate-300 mb-1">WAN {i + 1}</div>
                  <div className="grid grid-cols-2 gap-1 tabular-nums">
                    <div>
                      <div className="text-[9px] text-slate-500">↓ now</div>
                      <div className="text-blue-400 font-medium">{speedDown !== undefined ? formatBps(speedDown) : '—'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500">↑ now</div>
                      <div className="text-orange-400 font-medium">{speedUp !== undefined ? formatBps(speedUp) : '—'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500">↓ total</div>
                      <div>{totalDown !== undefined ? formatBytes(totalDown) : '—'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500">↑ total</div>
                      <div>{totalUp !== undefined ? formatBytes(totalUp) : '—'}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
