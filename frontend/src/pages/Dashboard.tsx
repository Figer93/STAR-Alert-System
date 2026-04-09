import { useEffect, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertCircle, AlertTriangle, Info, Server, Activity,
  Zap, BellOff
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Source, Alert } from '../types'
import { getSources, getTimeline } from '../lib/api'
import { useAlerts } from '../hooks/useAlerts'
import AlertItem from '../components/dashboard/AlertItem'
import AlertFilters, { type Filters } from '../components/alerts/AlertFilters'
import AlertDetail from '../components/alerts/AlertDetail'
import SourceStatus from '../components/dashboard/SourceStatus'
import { MetricCardSkeleton } from '../components/Skeleton'
import type { TimelineBucket } from '../types'

// ── Animated counter ──────────────────────────────────────────────────────────
function useCountUp(target: number, duration = 500) {
  const [val, setVal] = useState(target)
  const prev          = useRef(target)
  const raf           = useRef<number>(0)

  useEffect(() => {
    if (target === prev.current) return
    const start    = prev.current
    const delta    = target - start
    const startAt  = performance.now()

    const step = (now: number) => {
      const p = Math.min((now - startAt) / duration, 1)
      const e = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(start + delta * e))
      if (p < 1) raf.current = requestAnimationFrame(step)
      else prev.current = target
    }

    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration])

  return val
}

// ── KPI Card ─────────────────────────────────────────────────────────────────
const KPI_BG_MAP: Record<string, string> = {
  'var(--red)':   'rgba(239,68,68,0.06)',
  'var(--amber)': 'rgba(245,158,11,0.06)',
  'var(--blue)':  'rgba(59,130,246,0.06)',
  'var(--green)': 'rgba(34,197,94,0.06)',
  'var(--text)':  'rgba(255,255,255,0.02)',
}
const KPI_BORDER_MAP: Record<string, string> = {
  'var(--red)':   'rgba(239,68,68,0.18)',
  'var(--amber)': 'rgba(245,158,11,0.18)',
  'var(--blue)':  'rgba(59,130,246,0.18)',
  'var(--green)': 'rgba(34,197,94,0.18)',
}
interface KPIProps {
  label:   string
  value:   number
  colour:  string
  icon:    React.ElementType
  pulse?:  boolean
  sub?:    string
}

function KPICard({ label, value, colour, icon: Icon, pulse, sub }: KPIProps) {
  const display = useCountUp(value)

  const bg = KPI_BG_MAP[colour] ?? 'rgba(255,255,255,0.02)'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={pulse && value > 0 ? 'pulse-critical' : ''}
      style={{
        flex: 1, minWidth: 0,
        background: `radial-gradient(ellipse at top left, ${bg} 0%, transparent 70%), var(--bg-surface)`,
        border: `1px solid ${KPI_BORDER_MAP[colour] ?? 'var(--border)'}`,
        borderTop: `2px solid ${colour}`,
        borderRadius: 'var(--radius-lg)',
        padding: '14px 16px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8 }}>
            {label}
          </div>
          <div style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 32, fontWeight: 700,
            color: colour === 'var(--text)' ? 'var(--text-head)' : colour,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {display}
          </div>
          {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>{sub}</div>}
        </div>
        <div style={{
          width: 30, height: 30, borderRadius: 4,
          background: `${colour === 'var(--text)' ? 'rgba(255,255,255,0.05)' : bg}`,
          border: `1px solid var(--border)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={14} color={colour === 'var(--text)' ? 'var(--text-muted)' : colour} />
        </div>
      </div>
    </motion.div>
  )
}

// ── SVG Circular Gauge ────────────────────────────────────────────────────────
function HealthGauge({ score }: { score: number }) {
  const size = 96
  const cx = size / 2
  const cy = size / 2
  const r = 38
  const strokeWidth = 6
  const circumference = Math.PI * r  // half-circle

  const [animScore, setAnimScore] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => setAnimScore(score), 100)
    return () => clearTimeout(id)
  }, [score])

  const offset = circumference - (animScore / 100) * circumference
  const colour = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)'

  // Arc from 180° to 0° (left to right semicircle)
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`}>
        {/* Track */}
        <path
          d={arcPath}
          fill="none"
          stroke="var(--border-bright)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Progress arc */}
        <path
          d={arcPath}
          fill="none"
          stroke={colour}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.4s ease' }}
        />
        {/* Score text */}
        <text
          x={cx} y={cy + 4}
          textAnchor="middle"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700, fill: colour, transition: 'fill 0.4s ease' }}
        >
          {animScore}
        </text>
        <text
          x={cx} y={cy + 16}
          textAnchor="middle"
          style={{ fontSize: 8, fill: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          Health
        </text>
      </svg>
    </div>
  )
}

// ── Oscilloscope sparkline ────────────────────────────────────────────────────
function Sparkline({ data, colour = 'var(--blue)' }: { data: number[]; colour?: string }) {
  if (!data.length) return null
  const w = 200, h = 32
  const max = Math.max(...data, 1)
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (v / max) * (h - 4) - 2
    return `${x},${y}`
  })
  const d = `M ${pts.join(' L ')}`
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={colour} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ── Alert feed ────────────────────────────────────────────────────────────────
interface FeedProps {
  alerts:        Alert[]
  sources:       Source[]
  onAcknowledge: (id: number, by: string) => void
  loading:       boolean
}

function LiveFeed({ alerts, sources, onAcknowledge, loading }: FeedProps) {
  const [filters, setFilters] = useState<Filters>({ severity: '', source: '', status: '' })
  const [detail, setDetail]   = useState<Alert | null>(null)
  const parentRef             = useRef<HTMLDivElement>(null)
  const prevCount             = useRef(alerts.length)
  const [badgePulse, setBadgePulse] = useState(false)

  const filtered = alerts.filter(a => {
    if (filters.severity && a.severity !== filters.severity) return false
    if (filters.source   && a.source?.slug !== filters.source) return false
    if (filters.status   && a.status !== filters.status) return false
    return true
  })

  useEffect(() => {
    if (alerts.length > prevCount.current) {
      setBadgePulse(true)
      const t = setTimeout(() => setBadgePulse(false), 1200)
      return () => clearTimeout(t)
    }
    prevCount.current = alerts.length
  }, [alerts.length])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const virtualizer = useVirtualizer({
    count:            filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize:     () => 86,
    overscan:         8,
  })

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 80, borderRadius: 'var(--radius-lg)' }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={13} color="var(--accent)" />
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
            Live Feed
          </span>
          <motion.span
            animate={badgePulse ? { scale: [1, 1.25, 1] } : { scale: 1 }}
            transition={{ duration: 0.4 }}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-bright)',
              borderRadius: 3,
              padding: '1px 7px',
              fontSize: 11, fontWeight: 700,
              color: 'var(--text-head)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {filtered.length}
          </motion.span>
        </div>
        <AlertFilters filters={filters} sources={sources} onChange={setFilters} />
      </div>

      {/* Feed list */}
      <div ref={parentRef} style={{ overflow: 'auto', flex: 1 }}>
        {filtered.length === 0 ? (
          <div style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '40px 24px',
            textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <BellOff size={24} color="var(--text-dim)" />
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>No alerts match filters</span>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            <AnimatePresence initial={false}>
              {virtualizer.getVirtualItems().map(vItem => {
                const a = filtered[vItem.index]
                return (
                  <div
                    key={a.id}
                    style={{
                      position: 'absolute', top: 0, left: 0, right: 0,
                      transform: `translateY(${vItem.start}px)`,
                      paddingBottom: 5,
                    }}
                  >
                    <AlertItem alert={a} onAcknowledge={onAcknowledge} onDetail={setDetail} />
                  </div>
                )
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      <AlertDetail alert={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { alerts, stats, loading, wsConnected: _wsConnected, acknowledgeLocal } = useAlerts()
  const [sources, setSources]   = useState<Source[]>([])
  const [timeline, setTimeline] = useState<TimelineBucket[]>([])

  useEffect(() => {
    getSources().then(setSources).catch(() => {})
    getTimeline(24).then(setTimeline).catch(() => {})
  }, [])

  // Compute health score from stats
  const healthScore = stats
    ? Math.round(
        100 *
        (1 - (stats.critical * 1.0 + stats.warning * 0.5 + stats.info * 0.1) /
          Math.max(stats.total_active + stats.ok, 1))
      )
    : 100

  const sparkData = timeline.slice(-20).map(b => b.count)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, height: '100%', minHeight: 0, overflow: 'hidden' }}>

      {/* KPI row */}
      <div className="metric-row" style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <MetricCardSkeleton key={i} />)
        ) : (
          <>
            <KPICard label="Critical"       value={stats?.critical ?? 0}     colour="var(--red)"   icon={AlertCircle}   pulse />
            <KPICard label="Warning"        value={stats?.warning ?? 0}      colour="var(--amber)" icon={AlertTriangle} />
            <KPICard label="Info"           value={stats?.info ?? 0}         colour="var(--blue)"  icon={Info} />
            <KPICard
              label="Sources"
              value={stats?.sources_online ?? 0}
              colour="var(--green)"
              icon={Server}
              sub={`of ${stats?.sources_total ?? 0} online`}
            />
            <KPICard label="Active"         value={stats?.total_active ?? 0} colour="var(--text)"  icon={Activity} />
          </>
        )}
      </div>

      {/* Main layout */}
      <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>

        {/* Alert feed */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <LiveFeed alerts={alerts} sources={sources} onAcknowledge={acknowledgeLocal} loading={loading} />
        </div>

        {/* Right sidebar */}
        <div className="dashboard-sidebar" style={{ width: 248, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>

          {/* Health gauge */}
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', alignSelf: 'flex-start', marginBottom: 4 }}>
              System Health
            </div>
            <HealthGauge score={Math.max(0, Math.min(100, healthScore))} />
          </div>

          {/* Activity sparkline */}
          <div className="card" style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8 }}>
              24h Activity
            </div>
            {sparkData.length > 1 ? (
              <Sparkline data={sparkData} colour="var(--accent)" />
            ) : (
              <div className="skeleton" style={{ height: 32 }} />
            )}
          </div>

          {/* Sources */}
          <SourceStatus sources={sources} />

          {/* Stats by severity mini */}
          {stats && (
            <div className="card" style={{ padding: '12px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8 }}>
                Severity Breakdown
              </div>
              {([ ['critical', stats.critical, 'var(--red)'], ['warning', stats.warning, 'var(--amber)'], ['info', stats.info, 'var(--blue)'] ] as const).map(([sev, count, colour]) => (
                <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: colour, boxShadow: `0 0 4px ${colour}`, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'capitalize', flex: 1 }}>{sev}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600, color: count > 0 ? colour : 'var(--text-dim)' }}>
                    {count}
                  </span>
                  {/* Mini bar */}
                  <div style={{ width: 48, height: 3, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.round((count / Math.max(stats.total_active, 1)) * 100)}%`,
                      background: colour,
                      borderRadius: 2,
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) { .dashboard-sidebar { display: none; } }
      `}</style>
    </div>
  )
}
