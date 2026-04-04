import { useEffect, useMemo, useState } from 'react'
import { Activity, Download } from 'lucide-react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, ReferenceLine, Brush, ResponsiveContainer,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LatencyResponse {
  targets: string[]
  series:  Record<string, number | string | null>[]
}

interface TargetStats {
  target:  string
  color:   string
  avgRtt:  number | null
  p95Rtt:  number | null
  maxRtt:  number | null
  avgLoss: number | null
  uptime:  number
  status:  'healthy' | 'degraded' | 'down' | 'no-data'
}

interface TimelineSegment {
  startMs:   number
  endMs:     number
  health:    'healthy' | 'degraded' | 'down'
  worstLoss: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PERIODS = [
  { label: '15 m', value: '15m' },
  { label: '1 h',  value: '1h'  },
  { label: '6 h',  value: '6h'  },
  { label: '24 h', value: '24h' },
  { label: '7 d',  value: '7d'  },
] as const
type Period = typeof PERIODS[number]['value']

const TARGET_COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4']

const SEG_COLORS: Record<TimelineSegment['health'], string> = {
  healthy:  '#22c55e',
  degraded: '#eab308',
  down:     '#ef4444',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_')
}

function getRtt(row: Record<string, number | string | null>, target: string): number | null {
  const v = row[`${sanitise(target)}_rtt`]
  return typeof v === 'number' ? v : null
}

function getLoss(row: Record<string, number | string | null>, target: string): number | null {
  const v = row[`${sanitise(target)}_loss`]
  return typeof v === 'number' ? v : null
}

function fmtTime(iso: string | unknown, period: Period): string {
  if (!iso || typeof iso !== 'string') return ''
  const d = new Date(iso)
  if (period === '7d') return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (period === '24h' || period === '6h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(s.length * p / 100) - 1)]
}

function segmentHealth(lossVal: number | null): TimelineSegment['health'] {
  if (lossVal == null || lossVal < 2)  return 'healthy'
  if (lossVal < 10)                    return 'degraded'
  return 'down'
}

function fmtMs(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

function fmtRtt(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(1)} ms`
}

// ── Stats computation ─────────────────────────────────────────────────────────

function computeStats(
  series: LatencyResponse['series'],
  targets: string[],
): TargetStats[] {
  return targets.map((target, i) => {
    const rtts   = series.map(r => getRtt(r, target)).filter((v): v is number => v != null)
    const losses = series.map(r => getLoss(r, target)).filter((v): v is number => v != null)
    const color  = TARGET_COLORS[i % TARGET_COLORS.length]

    if (!rtts.length) {
      return { target, color, avgRtt: null, p95Rtt: null, maxRtt: null, avgLoss: null, uptime: 100, status: 'no-data' }
    }

    const avgRtt  = rtts.reduce((s, v) => s + v, 0) / rtts.length
    const p95Rtt  = percentile(rtts, 95)
    const maxRtt  = Math.max(...rtts)
    const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 0
    const uptimeN = losses.length ? losses.filter(v => v < 10).length / losses.length * 100 : 100

    let status: TargetStats['status'] = 'healthy'
    if (avgLoss >= 10)              status = 'down'
    else if (avgLoss >= 2 || avgRtt >= 150) status = 'degraded'

    return { target, color, avgRtt, p95Rtt, maxRtt, avgLoss, uptime: uptimeN, status }
  })
}

// ── Timeline segments ─────────────────────────────────────────────────────────

function buildSegments(
  series: LatencyResponse['series'],
  target: string,
): TimelineSegment[] {
  const out: TimelineSegment[] = []
  let cur: TimelineSegment | null = null

  for (const row of series) {
    const t     = new Date(row.time as string).getTime()
    const l     = getLoss(row, target)
    const h     = segmentHealth(l)

    if (!cur || cur.health !== h) {
      if (cur) out.push(cur)
      cur = { startMs: t, endMs: t, health: h, worstLoss: l ?? 0 }
    } else {
      cur.endMs = t
      if ((l ?? 0) > cur.worstLoss) cur.worstLoss = l ?? 0
    }
  }
  if (cur) out.push(cur)
  return out
}

// ── Interpretation ────────────────────────────────────────────────────────────

interface Interpretation { icon: string; headline: string; lines: string[] }

function interpret(stats: TargetStats[], series: LatencyResponse['series']): Interpretation {
  if (!series.length || !stats.length) {
    return {
      icon: '📡',
      headline: 'No data for selected period',
      lines: ['Ensure collector stack is running and targets are configured.'],
    }
  }

  const issues   = stats.filter(s => s.status === 'degraded' || s.status === 'down')
  const isGateway = (s: TargetStats) => /gateway|gw/i.test(s.target)

  if (!issues.length) {
    const lines: string[] = []
    for (const s of stats) {
      if (s.avgRtt == null) continue
      const q = s.avgRtt < 5 ? 'excellent' : s.avgRtt < 20 ? 'good' : s.avgRtt < 50 ? 'fair' : 'poor'
      lines.push(`${s.target}: ${s.avgRtt.toFixed(1)} ms avg (${q})`)
    }
    lines.push('No packet loss detected in the selected period.')
    return { icon: '✅', headline: 'All targets healthy', lines }
  }

  // Find worst outage per degraded target
  const lines: string[] = []
  for (const s of issues) {
    const segs = buildSegments(series, s.target).filter(seg => seg.health !== 'healthy')
    const worst = segs.sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))[0]
    if (worst) {
      const startStr = new Date(worst.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const endStr   = new Date(worst.endMs  ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      lines.push(
        `${s.target} showed ${worst.worstLoss.toFixed(0)}% packet loss ${startStr}–${endStr} (${fmtMs(worst.endMs - worst.startMs)})`
      )
    } else {
      lines.push(`${s.target}: ${s.avgLoss?.toFixed(1) ?? '0'}% avg packet loss`)
    }
  }

  const gatewayIssues = issues.filter(isGateway)
  const wanIssues     = issues.filter(s => !isGateway(s))

  if (wanIssues.length && !gatewayIssues.length) {
    lines.push('Gateway latency was normal throughout — internal network was fine.')
    lines.push('Likely cause: ISP or upstream routing issue.')
    lines.push('Recommendation: Check ISP status page or contact provider.')
    return { icon: '⚠️', headline: 'WAN degradation detected', lines }
  }

  if (gatewayIssues.length) {
    lines.push('Gateway is also affected — investigate local network equipment or cabling.')
    return { icon: '🔴', headline: 'Internal network degradation', lines }
  }

  return { icon: '⚠️', headline: 'Degradation detected', lines }
}

// ── Custom recharts tooltip ───────────────────────────────────────────────────

interface TooltipEntry { dataKey: string; value: number | null | undefined; color: string }

function ChartTooltip({
  active, payload, label, visibleTargets, period,
}: {
  active?:         boolean
  payload?:        TooltipEntry[]
  label?:          string
  visibleTargets:  string[]
  period:          Period
}) {
  if (!active || !payload?.length) return null

  return (
    <div style={{
      background:   'var(--bg-surface)',
      border:       '1px solid var(--border-bright)',
      borderRadius: 'var(--radius)',
      padding:      '8px 12px',
      fontSize:     11,
      boxShadow:    '0 4px 16px rgba(0,0,0,0.5)',
      minWidth:     180,
    }}>
      <p style={{ color: 'var(--text-dim)', margin: '0 0 6px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
        {fmtTime(label, period)}
      </p>
      {visibleTargets.map((target, i) => {
        const key       = sanitise(target)
        const rttEntry  = payload.find(p => p.dataKey === `${key}_rtt`)
        const lossEntry = payload.find(p => p.dataKey === `${key}_loss`)
        const color     = TARGET_COLORS[i % TARGET_COLORS.length]
        const rttVal    = rttEntry?.value
        const lossVal   = lossEntry?.value

        return (
          <div key={target} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text)', fontWeight: 600, flex: 1 }}>{target}</span>
            <span style={{ color, fontWeight: 700 }}>
              {rttVal != null ? `${rttVal.toFixed(1)} ms` : '—'}
            </span>
            {lossVal != null && lossVal > 0 && (
              <span style={{ color: '#ef4444', fontSize: 10, fontWeight: 600 }}>
                {lossVal.toFixed(1)}%↓
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Stats card ────────────────────────────────────────────────────────────────

function StatsCard({ stat }: { stat: TargetStats }) {
  const statusColor = {
    healthy:  '#22c55e',
    degraded: '#eab308',
    down:     '#ef4444',
    'no-data':'#6b7280',
  }[stat.status]

  return (
    <div style={{
      flex:         '1 1 160px',
      background:   'var(--bg-surface)',
      border:       `1px solid var(--border)`,
      borderTop:    `2px solid ${stat.color}`,
      borderRadius: 'var(--radius)',
      padding:      '12px 14px',
    }}>
      {/* Target name + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor, boxShadow: `0 0 5px ${statusColor}`,
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-head)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stat.target}
        </span>
      </div>

      {stat.status === 'no-data' ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: 0 }}>No data</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
          <StatItem label="Avg RTT"  value={fmtRtt(stat.avgRtt)}           color={stat.color} />
          <StatItem label="P95 RTT"  value={fmtRtt(stat.p95Rtt)}           />
          <StatItem label="Max RTT"  value={fmtRtt(stat.maxRtt)}           color={stat.maxRtt != null && stat.maxRtt > 150 ? '#ef4444' : undefined} />
          <StatItem label="Loss"     value={stat.avgLoss != null ? `${stat.avgLoss.toFixed(1)}%` : '—'}
                                     color={stat.avgLoss != null && stat.avgLoss > 0 ? '#ef4444' : undefined} />
          <StatItem label="Uptime"   value={`${stat.uptime.toFixed(1)}%`}  color={stat.uptime < 99 ? '#eab308' : '#22c55e'} />
        </div>
      )}
    </div>
  )
}

function StatItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 2px' }}>
        {label}
      </p>
      <p style={{ fontSize: 13, fontWeight: 700, color: color ?? 'var(--text-head)', margin: 0 }}>
        {value}
      </p>
    </div>
  )
}

// ── Outage Timeline ───────────────────────────────────────────────────────────

interface TimelineTip {
  segment: TimelineSegment
  target:  string
  x:       number
  y:       number
}

function OutageTimeline({ series, targets }: {
  series:  LatencyResponse['series']
  targets: string[]
}) {
  const [tip, setTip] = useState<TimelineTip | null>(null)

  if (!series.length || !targets.length) return null

  const firstMs = new Date(series[0].time as string).getTime()
  const lastMs  = new Date(series[series.length - 1].time as string).getTime()
  const span    = lastMs - firstMs || 1

  return (
    <div style={{
      background:   'var(--bg-surface)',
      border:       '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding:      '14px 16px',
    }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 12px' }}>
        Outage Timeline
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {targets.map((target, i) => {
          const segs = buildSegments(series, target)
          return (
            <div key={target} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Label */}
              <span style={{
                fontSize: 11, color: TARGET_COLORS[i % TARGET_COLORS.length],
                fontWeight: 600, width: 100, flexShrink: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {target}
              </span>

              {/* Bar */}
              <div style={{
                flex: 1, height: 20, borderRadius: 4, overflow: 'hidden',
                display: 'flex', background: 'var(--bg-raised)',
                border: '1px solid var(--border)',
              }}>
                {segs.map((seg, si) => {
                  const w = ((seg.endMs - seg.startMs) / span) * 100
                  return (
                    <div
                      key={si}
                      onMouseEnter={e => setTip({ segment: seg, target, x: e.clientX, y: e.clientY })}
                      onMouseMove={e  => tip && setTip({ segment: seg, target, x: e.clientX, y: e.clientY })}
                      onMouseLeave={()  => setTip(null)}
                      style={{
                        width:      `${Math.max(w, 0.3)}%`,
                        background: SEG_COLORS[seg.health],
                        opacity:    seg.health === 'healthy' ? 0.7 : 1,
                        cursor:     'default',
                        flexShrink: 0,
                      }}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Time axis labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, paddingLeft: 110 }}>
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {new Date(firstMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {new Date(lastMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 10, paddingLeft: 110 }}>
        {(Object.entries(SEG_COLORS) as [TimelineSegment['health'], string][]).map(([h, c]) => (
          <span key={h} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-dim)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
            {h.charAt(0).toUpperCase() + h.slice(1)}
            {h === 'degraded' && ' (2–10% loss)'}
            {h === 'down'     && ' (>10% loss)'}
          </span>
        ))}
      </div>

      {/* Hover tooltip */}
      {tip && (
        <div style={{
          position:     'fixed',
          left:         tip.x + 12,
          top:          tip.y - 12,
          zIndex:       9999,
          background:   'var(--bg-surface)',
          border:       '1px solid var(--border-bright)',
          borderRadius: 'var(--radius)',
          padding:      '8px 12px',
          fontSize:     11,
          pointerEvents:'none',
          boxShadow:    '0 4px 16px rgba(0,0,0,0.5)',
          minWidth:     180,
        }}>
          <p style={{ fontWeight: 700, color: SEG_COLORS[tip.segment.health], margin: '0 0 4px', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.06em' }}>
            {tip.segment.health} — {tip.target}
          </p>
          <p style={{ color: 'var(--text-dim)', margin: '0 0 2px' }}>
            {new Date(tip.segment.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' — '}
            {new Date(tip.segment.endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
          <p style={{ color: 'var(--text-dim)', margin: '0 0 2px' }}>
            Duration: {fmtMs(tip.segment.endMs - tip.segment.startMs)}
          </p>
          {tip.segment.health !== 'healthy' && (
            <p style={{ color: '#ef4444', margin: 0, fontWeight: 600 }}>
              Worst loss: {tip.segment.worstLoss.toFixed(1)}%
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Interpretation Panel ──────────────────────────────────────────────────────

function InterpretationPanel({ stats, series }: {
  stats:  TargetStats[]
  series: LatencyResponse['series']
}) {
  const info = useMemo(() => interpret(stats, series), [stats, series])

  const iconBg: Record<string, string> = {
    '✅': '#22c55e22',
    '⚠️': '#eab30822',
    '🔴': '#ef444422',
    '📡': '#3b82f622',
  }

  return (
    <div style={{
      width:          300,
      flexShrink:     0,
      display:        'flex',
      flexDirection:  'column',
      gap:            0,
    }}>
      <div style={{
        background:   'var(--bg-surface)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding:      '14px 16px',
        height:       '100%',
      }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 12px' }}>
          Analysis
        </p>

        {/* Icon + headline */}
        <div style={{
          display:      'flex',
          alignItems:   'center',
          gap:          10,
          background:   iconBg[info.icon] ?? 'var(--bg-raised)',
          borderRadius: 'var(--radius)',
          padding:      '10px 12px',
          marginBottom: 14,
        }}>
          <span style={{ fontSize: 20 }}>{info.icon}</span>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-head)', lineHeight: 1.3 }}>
            {info.headline}
          </span>
        </div>

        {/* Bullet lines */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {info.lines.map((line, i) => (
            <p key={i} style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>
              {line}
            </p>
          ))}
        </div>

        {/* Status legend */}
        {stats.length > 0 && (
          <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 10px' }}>
              Current Status
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {stats.map(s => {
                const sc = { healthy: '#22c55e', degraded: '#eab308', down: '#ef4444', 'no-data': '#6b7280' }[s.status]
                return (
                  <div key={s.target} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, boxShadow: `0 0 4px ${sc}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{s.target}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                      {fmtRtt(s.avgRtt)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function NetworkLatency() {
  const [period, setPeriod]         = useState<Period>('1h')
  const [data, setData]             = useState<LatencyResponse | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(false)
  const [checked, setChecked]       = useState<Set<string>>(new Set())
  const [checkedInit, setCheckedInit] = useState(false)

  // ── Fetch ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/network/latency?period=${period}`)
        if (!res.ok) throw new Error('not ok')
        const d: LatencyResponse = await res.json()
        if (!cancelled) {
          setData(d)
          setError(false)
          // Initialise checkboxes once from targets
          if (!checkedInit && d.targets.length) {
            setChecked(new Set(d.targets))
            setCheckedInit(true)
          }
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [period, checkedInit])

  // ── Derived data ──────────────────────────────────────────────────────────

  const allTargets     = data?.targets ?? []
  const visibleTargets = allTargets.filter(t => checked.has(t))
  const series         = data?.series ?? []

  const stats = useMemo(
    () => computeStats(series, visibleTargets),
    [series, visibleTargets]
  )

  // Chart data: only keep time + visible targets' keys
  const chartData = useMemo(() => series.map(row => {
    const out: Record<string, number | string | null> = { time: row.time as string }
    for (const t of visibleTargets) {
      const k = sanitise(t)
      out[`${k}_rtt`]  = getRtt(row, t)
      out[`${k}_loss`] = getLoss(row, t)
    }
    return out
  }), [series, visibleTargets])

  function toggleTarget(t: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else              next.add(t)
      return next
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Activity size={16} color="var(--accent)" />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>Latency</h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            ICMP round-trip times per target — refreshes every 60 s
          </p>
        </div>

        {/* Export CSV */}
        {stats.length > 0 && (
          <button
            onClick={() => {
              const header = ['Target', 'Avg RTT (ms)', 'P95 RTT (ms)', 'Max RTT (ms)', 'Avg Loss %', 'Uptime %']
              const rows = stats.map(s => [
                s.target,
                s.avgRtt?.toFixed(1) ?? '',
                s.p95Rtt?.toFixed(1) ?? '',
                s.maxRtt?.toFixed(1) ?? '',
                s.avgLoss?.toFixed(1) ?? '0',
                s.uptime.toFixed(1),
              ])
              const csv = [header, ...rows].map(r => r.join(',')).join('\n')
              const a = Object.assign(document.createElement('a'), {
                href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
                download: `latency_${period}_${new Date().toISOString().slice(0, 10)}.csv`,
              })
              a.click()
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'none', border: '1px solid var(--border)',
              color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)',
              padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}
          >
            <Download size={11} /> Export CSV
          </button>
        )}

        {/* Period buttons */}
        <div style={{ display: 'flex', gap: 3 }}>
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border:      period === p.value ? '1px solid var(--border-bright)' : '1px solid transparent',
                background:  period === p.value ? 'var(--bg-raised)' : 'transparent',
                color:       period === p.value ? 'var(--text-head)' : 'var(--text-dim)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Target checkboxes */}
        {allTargets.length > 0 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {allTargets.map((t, i) => {
              const color = TARGET_COLORS[i % TARGET_COLORS.length]
              const on    = checked.has(t)
              return (
                <label
                  key={t}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}
                >
                  <div
                    onClick={() => toggleTarget(t)}
                    style={{
                      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                      background:  on ? color : 'transparent',
                      border:      `2px solid ${color}`,
                      display:     'flex', alignItems: 'center', justifyContent: 'center',
                      transition:  'background 0.12s',
                      cursor:      'pointer',
                    }}
                  >
                    {on && <span style={{ color: '#000', fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                  </div>
                  <span
                    onClick={() => toggleTarget(t)}
                    style={{ fontSize: 11, color: on ? color : 'var(--text-dim)', fontWeight: on ? 600 : 400 }}
                  >
                    {t}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Loading skeleton ────────────────────────────────────────────────── */}
      {loading && !data && (
        <div className="card" style={{ height: 320, animation: 'pulse 1.4s ease-in-out infinite', flexShrink: 0 }} />
      )}

      {/* ── Empty / error ────────────────────────────────────────────────────── */}
      {(error || (!loading && !series.length)) && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Activity size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>No latency data available</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            Deploy the collector stack and configure ICMP targets to begin receiving metrics.
          </p>
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────────────── */}
      {!loading && series.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>

          {/* Left column: chart + stats + timeline */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

            {/* ── ComposedChart ─────────────────────────────────────────────── */}
            <div className="card" style={{ padding: '14px 4px 4px 4px', flexShrink: 0 }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 12px', paddingLeft: 12 }}>
                RTT over time
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 56, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" strokeOpacity={0.5} />

                  {/* Left axis: RTT ms */}
                  <YAxis
                    yAxisId="rtt"
                    orientation="left"
                    tick={{ fontSize: 10, fill: 'var(--text-dim)' }}
                    tickFormatter={v => `${v}ms`}
                    width={52}
                    allowDecimals={false}
                  />

                  {/* Right axis: loss % */}
                  <YAxis
                    yAxisId="loss"
                    orientation="right"
                    domain={[0, 100]}
                    tick={{ fontSize: 10, fill: 'var(--text-dim)' }}
                    tickFormatter={v => `${v}%`}
                    width={40}
                    allowDecimals={false}
                  />

                  <XAxis
                    dataKey="time"
                    tickFormatter={v => fmtTime(v, period)}
                    tick={{ fontSize: 10, fill: 'var(--text-dim)' }}
                    minTickGap={60}
                  />

                  <ReTooltip
                    content={
                      <ChartTooltip
                        visibleTargets={visibleTargets}
                        period={period}
                      />
                    }
                  />

                  {/* 50ms warning threshold */}
                  <ReferenceLine
                    yAxisId="rtt"
                    y={50}
                    stroke="#eab308"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: '50ms', position: 'insideTopLeft', fontSize: 9, fill: '#eab308' }}
                  />

                  {/* 150ms critical threshold */}
                  <ReferenceLine
                    yAxisId="rtt"
                    y={150}
                    stroke="#ef4444"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: '150ms', position: 'insideTopLeft', fontSize: 9, fill: '#ef4444' }}
                  />

                  {/* Loss areas (behind RTT lines, right axis) */}
                  {visibleTargets.map((t, i) => (
                    <Area
                      key={`${t}_loss`}
                      yAxisId="loss"
                      dataKey={`${sanitise(t)}_loss`}
                      stroke="none"
                      fill={TARGET_COLORS[i % TARGET_COLORS.length]}
                      fillOpacity={0.1}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}

                  {/* RTT lines (primary) */}
                  {visibleTargets.map((t, i) => (
                    <Line
                      key={`${t}_rtt`}
                      yAxisId="rtt"
                      dataKey={`${sanitise(t)}_rtt`}
                      stroke={TARGET_COLORS[i % TARGET_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}

                  {/* Brush for zoom */}
                  <Brush
                    dataKey="time"
                    height={24}
                    travellerWidth={8}
                    fill="var(--bg-raised)"
                    stroke="var(--border)"
                    tickFormatter={v => fmtTime(v, period)}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* ── Stats cards ───────────────────────────────────────────────── */}
            {stats.length > 0 && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
                {stats.map(s => <StatsCard key={s.target} stat={s} />)}
              </div>
            )}

            {/* ── Outage timeline ───────────────────────────────────────────── */}
            {series.length > 1 && (
              <OutageTimeline series={series} targets={visibleTargets} />
            )}
          </div>

          {/* Right column: interpretation */}
          <InterpretationPanel stats={stats} series={series} />
        </div>
      )}
    </div>
  )
}
