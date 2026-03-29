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
}

export default function MetricCard({ label, value, colour, glow, sub, icon: Icon }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '12px 16px',
        flex: 1,
        minWidth: 0,
        position: 'relative',
        overflow: 'hidden',
        transition: 'border-color 0.15s ease',
      }}
      whileHover={{ borderColor: 'var(--border-bright)' }}
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
            color: 'var(--text-dim)', fontSize: 10,
            textTransform: 'uppercase', letterSpacing: '0.08em',
            marginBottom: 6,
          }}>
            {label}
          </div>
          <div
            className="mono"
            style={{ fontSize: 30, fontWeight: 700, color: colour ?? 'var(--text-head)', lineHeight: 1 }}
          >
            {value}
          </div>
          {sub && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
              {sub}
            </div>
          )}
        </div>

        {Icon && (
          <div style={{
            width: 32, height: 32,
            borderRadius: 'var(--radius-sm)',
            background: colour ? `${colour}1a` : 'var(--bg-raised)',
            border: `1px solid ${colour ? `${colour}33` : 'var(--border)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={15} color={colour ?? 'var(--text-dim)'} />
          </div>
        )}
      </div>
    </motion.div>
  )
}
