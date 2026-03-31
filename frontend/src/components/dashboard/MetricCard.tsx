import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'

interface Props {
  label:   string
  value:   number | string
  colour?: string
  glow?:   string
  sub?:    string
  icon?:   LucideIcon
  trend?:  'up' | 'down' | 'stable'
  pulse?:  boolean
}

// Animate numeric value from 0 to target on mount
function useCountUp(target: number | string, duration = 600) {
  const [display, setDisplay] = useState(0)
  const frameRef = useRef<number>(0)

  useEffect(() => {
    const numeric = typeof target === 'number' ? target : null
    if (numeric === null) return

    const start = performance.now()
    const animate = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(eased * numeric))
      if (progress < 1) frameRef.current = requestAnimationFrame(animate)
    }
    frameRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frameRef.current)
  }, [target, duration])

  return typeof target === 'number' ? display : target
}

// Derive a radial gradient from the severity colour
function radialGradient(colour?: string): string | undefined {
  if (!colour) return undefined
  // Map CSS var names to rgba equivalents for the gradient
  const map: Record<string, string> = {
    'var(--red)':   'rgba(239,68,68,0.08)',
    'var(--amber)': 'rgba(245,158,11,0.07)',
    'var(--blue)':  'rgba(59,130,246,0.07)',
    'var(--green)': 'rgba(34,197,94,0.07)',
  }
  const rgba = map[colour]
  return rgba ? `radial-gradient(ellipse at top left, ${rgba} 0%, transparent 65%)` : undefined
}

export default function MetricCard({ label, value, colour, glow, sub, icon: Icon, pulse }: Props) {
  const displayValue = useCountUp(value)
  const bg = radialGradient(colour)

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className={pulse ? 'pulse-critical' : ''}
      style={{
        background: bg
          ? `${bg}, rgba(255,255,255,0.03)`
          : 'rgba(255,255,255,0.03)',
        border: `1px solid ${colour ? `${colour}22` : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '18px 16px',
        flex: 1,
        minWidth: 0,
        position: 'relative',
        overflow: 'hidden',
        cursor: 'default',
        transition: 'border-color 0.15s ease, background 0.15s ease',
      }}
      whileHover={{
        borderColor: colour ? `${colour}44` : 'var(--border-bright)',
        background: bg
          ? `${bg}, rgba(255,255,255,0.05)`
          : 'rgba(255,255,255,0.05)',
      }}
    >
      {/* Colour accent bar at top */}
      {colour && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          height: 2,
          background: colour,
          boxShadow: glow,
        }} />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{
            color: 'var(--text-dim)', fontSize: 11,
            textTransform: 'uppercase', letterSpacing: '0.10em',
            marginBottom: 8, fontWeight: 500,
          }}>
            {label}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 36, fontWeight: 700,
              color: colour ?? 'var(--text-head)',
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {displayValue}
          </div>
          {sub && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 5 }}>
              {sub}
            </div>
          )}
        </div>

        {Icon && (
          <div style={{
            width: 34, height: 34,
            borderRadius: 8,
            background: colour ? `${colour}14` : 'rgba(255,255,255,0.04)',
            border: `1px solid ${colour ? `${colour}28` : 'var(--border)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            opacity: 0.85,
          }}>
            <Icon size={16} color={colour ?? 'var(--text-dim)'} />
          </div>
        )}
      </div>
    </motion.div>
  )
}
