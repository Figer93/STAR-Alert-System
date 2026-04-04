// ── StatusDot ──────────────────────────────────────────────────────────────────
// Colored dot indicating network health status.
// Props:
//   status    — 'healthy' | 'degraded' | 'down' | 'unknown'
//   animated  — when true, dot pulses (use for live/active states)
//   size      — diameter in px (default 10)

const STATUS_COLORS: Record<string, string> = {
  healthy:  'var(--green)',
  degraded: 'var(--amber)',
  down:     'var(--red)',
  unknown:  '#4b5563',
}

const STATUS_GLOW: Record<string, string> = {
  healthy:  '0 0 8px var(--green)',
  degraded: '0 0 8px var(--amber)',
  down:     '0 0 8px var(--red)',
  unknown:  'none',
}

interface Props {
  status:    'healthy' | 'degraded' | 'down' | 'unknown'
  animated?: boolean
  size?:     number
}

export default function StatusDot({ status, animated = false, size = 10 }: Props) {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.unknown
  const glow  = STATUS_GLOW[status]  ?? 'none'

  return (
    <>
      <span
        style={{
          display: 'inline-block',
          width:  size,
          height: size,
          borderRadius: '50%',
          flexShrink: 0,
          backgroundColor: color,
          boxShadow: glow,
          animation: animated && status !== 'unknown' ? 'status-dot-pulse 2s ease-in-out infinite' : 'none',
        }}
      />
      <style>{`
        @keyframes status-dot-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </>
  )
}
