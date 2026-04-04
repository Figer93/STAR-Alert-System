// ── SeverityBadge ──────────────────────────────────────────────────────────────
// Coloured pill badge for incident/alert severity levels.
// Props:
//   severity — 'low' | 'medium' | 'high' | 'critical'
//   small    — reduces padding/font-size (default false)

type Severity = 'low' | 'medium' | 'high' | 'critical'

const CONFIG: Record<Severity, { label: string; color: string; bg: string; glow: string }> = {
  low: {
    label: 'Low',
    color: '#22c55e',
    bg:    'rgba(34, 197, 94, 0.12)',
    glow:  'none',
  },
  medium: {
    label: 'Medium',
    color: 'var(--amber)',
    bg:    'var(--amber-dim)',
    glow:  'none',
  },
  high: {
    label: 'High',
    color: '#f97316',
    bg:    'rgba(249, 115, 22, 0.12)',
    glow:  'none',
  },
  critical: {
    label: 'Critical',
    color: 'var(--red)',
    bg:    'var(--red-dim)',
    glow:  '0 0 6px rgba(239, 68, 68, 0.35)',
  },
}

interface Props {
  severity: Severity | string
  small?:   boolean
}

export default function SeverityBadge({ severity, small = false }: Props) {
  const cfg = CONFIG[severity as Severity] ?? {
    label: severity,
    color: 'var(--text-muted)',
    bg:    'var(--gray-dim)',
    glow:  'none',
  }

  return (
    <span style={{
      display:      'inline-block',
      padding:      small ? '2px 7px' : '3px 10px',
      borderRadius: 20,
      fontSize:     small ? 10 : 11,
      fontWeight:   600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color:        cfg.color,
      background:   cfg.bg,
      boxShadow:    cfg.glow,
      border:       `1px solid ${cfg.color}33`,
      whiteSpace:   'nowrap',
    }}>
      {cfg.label}
    </span>
  )
}
