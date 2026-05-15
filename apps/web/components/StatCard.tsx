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
  const toneCls = {
    default: 'text-slate-100',
    green: 'text-accent-green',
    red: 'text-accent-red',
    amber: 'text-accent-amber',
    purple: 'text-accent-purple',
  }[tone];

  return (
    <div className="card p-3 sm:p-5 flex flex-col gap-2 sm:gap-3 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="stat-label truncate">{label}</div>
        {icon && <div className="text-slate-500 shrink-0">{icon}</div>}
      </div>
      <div className={clsx('text-xl sm:text-2xl lg:text-3xl font-bold tabular-nums truncate', toneCls)}>{value}</div>
      {hint && <div className="text-[10px] sm:text-xs text-slate-400 truncate">{hint}</div>}
    </div>
  );
}
