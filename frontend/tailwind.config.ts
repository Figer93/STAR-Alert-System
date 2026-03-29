import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base:     'var(--bg-base)',
          surface:  'var(--bg-surface)',
          raised:   'var(--bg-raised)',
          elevated: 'var(--bg-elevated)',
        },
        border: {
          DEFAULT: 'var(--border)',
          bright:  'var(--border-bright)',
        },
        text: {
          DEFAULT: 'var(--text)',
          dim:     'var(--text-dim)',
          muted:   'var(--text-muted)',
          head:    'var(--text-head)',
          bright:  'var(--text-bright)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          dim:     'var(--accent-dim)',
        },
        severity: {
          critical: 'var(--red)',
          warning:  'var(--amber)',
          info:     'var(--blue)',
          ok:       'var(--green)',
        },
      },
      fontFamily: {
        sans:  ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono:  ['JetBrains Mono', 'ui-monospace', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '1.4', letterSpacing: '0.04em' }],
        xs:    ['11px', { lineHeight: '1.5' }],
        sm:    ['12px', { lineHeight: '1.5' }],
        base:  ['13px', { lineHeight: '1.5' }],
        md:    ['14px', { lineHeight: '1.5' }],
      },
      borderRadius: {
        sm:  'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg:  'var(--radius-lg)',
        xl:  'var(--radius-xl)',
      },
      boxShadow: {
        'glow-red':    'var(--glow-red)',
        'glow-amber':  'var(--glow-amber)',
        'glow-blue':   'var(--glow-blue)',
        'glow-green':  'var(--glow-green)',
        'glow-accent': 'var(--glow-accent)',
        'card':        '0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)',
        'card-hover':  '0 4px 12px rgba(0,0,0,0.5)',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      zIndex: {
        'header':  '10',
        'drawer':  '20',
        'modal':   '30',
        'toast':   '50',
        'tooltip': '60',
      },
    },
  },
  plugins: [],
} satisfies Config
