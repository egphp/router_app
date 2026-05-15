import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'Fraunces', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'Geist', 'ui-sans-serif', 'system-ui'],
        mono: ['var(--font-mono)', 'Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Aurora palette — warm midnight base + bright accents
        // Designed in OKLCH for perceptual uniformity
        bg: {
          DEFAULT: '#13162a',   // oklch(0.20 0.04 275) — midnight w/ warm tint
          card: '#1c2040',      // oklch(0.26 0.05 275)
          elevated: '#252a4c',  // oklch(0.31 0.06 275)
          border: '#3a3f6b',    // oklch(0.42 0.07 275)
          mute: '#2a2f54',
        },
        accent: {
          DEFAULT: '#f5b884',   // peach — primary
          peach: '#f5b884',     // oklch(0.82 0.13 50)
          mint: '#7ce0bc',      // oklch(0.85 0.13 165)
          lavender: '#b7a6ff',  // oklch(0.78 0.14 295)
          sun: '#ffd66a',       // oklch(0.88 0.14 90)
          coral: '#ff8585',     // oklch(0.74 0.18 25)
          rose: '#ff9ed5',      // oklch(0.78 0.13 340)
          ice: '#9ee6ff',       // oklch(0.88 0.10 230)
          // Semantic aliases (back-compat)
          green: '#7ce0bc',
          red: '#ff8585',
          amber: '#ffd66a',
          purple: '#b7a6ff',
        },
        text: {
          primary: '#f0eee6',   // warm cream
          secondary: '#c8c3d8', // soft lavender-grey
          muted: '#8e8aa8',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
        'spin-slow': 'spin 3s linear infinite',
        'shimmer': 'shimmer 2.5s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(16px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
      borderRadius: {
        'xl2': '20px',
        'pill': '999px',
      },
      boxShadow: {
        // Tinted shadows instead of grey blur
        'card': '0 1px 0 rgba(245, 184, 132, 0.04) inset, 0 12px 32px -16px rgba(19, 22, 42, 0.6), 0 2px 8px -2px rgba(19, 22, 42, 0.4)',
        'card-hover': '0 1px 0 rgba(245, 184, 132, 0.08) inset, 0 24px 48px -20px rgba(124, 224, 188, 0.15), 0 4px 16px -4px rgba(19, 22, 42, 0.5)',
        'peach': '0 8px 24px -8px rgba(245, 184, 132, 0.35), 0 2px 4px -1px rgba(245, 184, 132, 0.2)',
        'mint':  '0 8px 24px -8px rgba(124, 224, 188, 0.35), 0 2px 4px -1px rgba(124, 224, 188, 0.2)',
        'lavender': '0 8px 24px -8px rgba(183, 166, 255, 0.35), 0 2px 4px -1px rgba(183, 166, 255, 0.2)',
        'coral': '0 8px 24px -8px rgba(255, 133, 133, 0.35), 0 2px 4px -1px rgba(255, 133, 133, 0.2)',
      },
    },
  },
  plugins: [],
};

export default config;
