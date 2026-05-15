import { ReactNode } from 'react';
import { clsx } from 'clsx';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'green' | 'red' | 'amber' | 'purple';
}

export function StatCard({ label, value, hint, icon, tone = 'default' }: Props) {
  const toneStyle = {
    default: { value: 'text-slate-100', iconBg: 'from-slate-700/40 to-slate-800/20', iconRing: 'ring-slate-700/40', glow: '' },
    green:   { value: 'bg-gradient-to-br from-emerald-300 to-emerald-500 bg-clip-text text-transparent', iconBg: 'from-emerald-500/25 to-emerald-700/10', iconRing: 'ring-emerald-500/30', glow: 'glow-green' },
    red:     { value: 'bg-gradient-to-br from-rose-300 to-rose-500 bg-clip-text text-transparent', iconBg: 'from-rose-500/25 to-rose-700/10', iconRing: 'ring-rose-500/30', glow: 'glow-red' },
    amber:   { value: 'bg-gradient-to-br from-amber-300 to-amber-500 bg-clip-text text-transparent', iconBg: 'from-amber-500/25 to-amber-700/10', iconRing: 'ring-amber-500/30', glow: '' },
    purple:  { value: 'bg-gradient-to-br from-fuchsia-300 to-purple-500 bg-clip-text text-transparent', iconBg: 'from-purple-500/25 to-fuchsia-700/10', iconRing: 'ring-purple-500/30', glow: 'glow-purple' },
  }[tone];

  return (
    <div className={clsx('card p-4 sm:p-5 flex flex-col gap-3 animate-fade-in transition-all hover:-translate-y-0.5', toneStyle.glow)}>
      <div className="flex items-start justify-between gap-2">
        <div className="stat-label truncate">{label}</div>
        {icon && (
          <div className={clsx(
            'shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br flex items-center justify-center ring-1',
            toneStyle.iconBg, toneStyle.iconRing,
          )}>
            <div className="text-slate-100">{icon}</div>
          </div>
        )}
      </div>
      <div className={clsx('text-2xl sm:text-3xl lg:text-[2rem] leading-none font-bold tabular-nums truncate tracking-tight', toneStyle.value)}>
        {value}
      </div>
      {hint && <div className="text-[11px] sm:text-xs text-slate-400 truncate">{hint}</div>}
    </div>
  );
}
