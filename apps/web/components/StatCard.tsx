import { ReactNode } from 'react';
import { clsx } from 'clsx';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  title?: string;
  tone?: 'default' | 'peach' | 'mint' | 'lavender' | 'sun' | 'coral' |
         // legacy aliases (back-compat)
         'green' | 'red' | 'amber' | 'purple';
}

export function StatCard({ label, value, hint, icon, title, tone = 'default' }: Props) {
  // Aurora tone palette: each tone provides an accent color + soft background
  const TONES = {
    default:  { accent: 'var(--peach)',    cardClass: 'card' },
    peach:    { accent: 'var(--peach)',    cardClass: 'card card-peach' },
    mint:     { accent: 'var(--mint)',     cardClass: 'card card-mint' },
    lavender: { accent: 'var(--lavender)', cardClass: 'card card-lavender' },
    sun:      { accent: 'var(--sun)',      cardClass: 'card card-sun' },
    coral:    { accent: 'var(--coral)',    cardClass: 'card card-coral' },
    // aliases
    green:    { accent: 'var(--mint)',     cardClass: 'card card-mint' },
    red:      { accent: 'var(--coral)',    cardClass: 'card card-coral' },
    amber:    { accent: 'var(--sun)',      cardClass: 'card card-sun' },
    purple:   { accent: 'var(--lavender)', cardClass: 'card card-lavender' },
  }[tone];

  return (
    <div title={title} className={clsx(TONES.cardClass, 'p-4 sm:p-5 flex flex-col gap-3 animate-fade-in transition-all hover:-translate-y-0.5')}>
      <div className="flex items-start justify-between gap-2">
        <div className="stat-label truncate">{label}</div>
        {icon && (
          <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
            style={{
              background: `color-mix(in oklab, ${TONES.accent} 14%, transparent)`,
              border: `1.5px solid color-mix(in oklab, ${TONES.accent} 40%, transparent)`,
              color: TONES.accent,
            }}>
            {icon}
          </div>
        )}
      </div>
      <div className="font-display tabular-nums truncate"
        style={{
          fontSize: 'clamp(1.6rem, 3vw, 2.15rem)',
          fontWeight: 600,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          color: tone === 'default' ? 'var(--text)' : TONES.accent,
          fontVariationSettings: '"opsz" 36, "SOFT" 50',
        }}>
        {value}
      </div>
      {hint && <div className="text-[11px] sm:text-xs truncate" style={{ color: 'var(--text-3)' }}>{hint}</div>}
    </div>
  );
}
