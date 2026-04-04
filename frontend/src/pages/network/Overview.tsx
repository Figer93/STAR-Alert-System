import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Globe, Wifi, Server, AlertTriangle, Activity,
  Clock, CheckCircle, ArrowRight, Zap,
} from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Overview {
  wan:             { status: string; latency_ms: number | null; packet_loss_pct: number | null }
  internal:        { status: string; active_devices: number; error_ports: number }
  collector:       { online: boolean; last_seen: string | null; sources: Record<string, boolean> }
  open_incidents:  number
  bytes_last_hour: number
  health_score:    number
}

interface LatencyResponse {
  targets: string[]
  series:  Record<string, number | string | null>[]
}

interface IncidentRow {
  id:              string
  started_at:      string
  resolved_at:     string | null
  severity:        string
  category:        string
  title:           string
  description:     string | null
  affected_ip:     string | null
  affected_switch: string | null
  auto_detected:   boolean
}

interface FlowRow {
  src_ip:           string | null
  src_hostname:     string | null
  dst_ip:           string | null
  dst_hostname:     string | null
  protocol_name:    string
  bytes:            number
  packets:          number
  direction:        string | null
  percent_of_total: number
}

// ─── Utility functions ───────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

function fmt(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`
  return `${bytes} B`
}

function relTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function sevColour(s: string): string {
  if (s === 'critical') return 'var(--red)'
  if (s === 'high')     return 'var(--red)'
  if (s === 'medium')   return 'var(--amber)'
  return 'var(--blue)'
}

function statusColour(s: string): string {
  if (s === 'healthy') return 'var(--green)'
  if (s === 'degraded') return 'var(--amber)'
  return 'var(--red)'
}

// SVG arc for the health gauge
function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const s = polarToXY(cx, cy, r, start)
  const e = polarToXY(cx, cy, r, end)
  const large = end - start > 180 ? 1 : 0
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
}

// target index → chart colour
const TARGET_COLOURS = ['#22c55e', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444']

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const c = statusColour(status)
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: c, boxShadow: `0 0 6px ${c}`, flexShrink: 0,
    }} />
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const c = sevColour(severity)
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: c,
      background: `${c}18`, border: `1px solid ${c}40`,
      borderRadius: 4, padding: '1px 5px',
    }}>
      {severity}
    </span>
  )
}

function SkeletonCard({ height = 90, flex = '1 1 180px' }: { height?: number; flex?: string }) {
  return (
    <div style={{
      flex, height, borderRadius: 'var(--radius-lg)',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--border)',
      animation: 'pulse 1.4s ease-in-out infinite',
    }} />
  )
}

// Health score SVG gauge
function HealthGauge({
  score, wanOk, portsOk, collectorOk,
}: {
  score: number
  wanOk: boolean
  portsOk: boolean
  collectorOk: boolean
}) {
  const CX = 72, CY = 78, R = 54
  const START = 135, SWEEP = 270
  const fillEnd = START + Math.max(1, (score / 100) * SWEEP)
  const colour =
    score >= 80 ? '#22c55e' :
    score >= 50 ? '#f59e0b' : '#ef4444'

  const sub = [
    { label: 'WAN',       ok: wanOk },
    { label: 'Ports',     ok: portsOk },
    { label: 'Collector', ok: collectorOk },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg width={144} height={100} style={{ overflow: 'visible' }}>
        {/* Background track */}
        <path
          d={arcPath(CX, CY, R, START, START + SWEEP)}
          fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={10} strokeLinecap="round"
        />
        {/* Filled arc */}
        <path
          d={arcPath(CX, CY, R, START, fillEnd)}
          fill="none" stroke={colour} strokeWidth={10} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${colour}80)` }}
        />
        {/* Score */}
        <text x={CX} y={CY - 4} textAnchor="middle" fill={colour}
          style={{ fontSize: 26, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
          {score}
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" fill="var(--text-dim)"
          style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {score >= 80 ? 'GOOD' : score >= 50 ? 'DEGRADED' : 'CRITICAL'}
        </text>
      </svg>

      {/* Sub-score pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {sub.map(({ label, ok }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 20,
            background: ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
          }}>
            {ok
              ? <CheckCircle size={11} color="var(--green)" />
              : <AlertTriangle size={11} color="var(--red)" />}
            <span style={{ fontSize: 11, fontWeight: 600, color: ok ? 'var(--green)' : 'var(--red)' }}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Custom recharts tooltip
function LatencyTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border-bright)',
      borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 11,
    }}>
      <p style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color, margin: '2px 0' }}>
          {p.name}: <strong>{p.value != null ? `${(p.value as number).toFixed(1)} ms` : '—'}</strong>
        </p>
      ))}
    </div>
  )
}

// Mini sparkline (no axes, no grid) for gateway RTT card
function Sparkline({ data, colour }: { data: number[]; colour: string }) {
  if (data.length < 2) return <div style={{ height: 36 }} />
  const max = Math.max(...data, 1)
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * 100
    const y = 100 - (v / max) * 100
    return `${x},${y}`
  }).join(' ')
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 36 }}>
      <polyline points={pts} fill="none" stroke={colour} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function NetworkOverview() {
  const navigate = useNavigate()

  const [overview,  setOverview]  = useState<Overview | null>(null)
  const [latency,   setLatency]   = useState<LatencyResponse | null>(null)
  const [incidents, setIncidents] = useState<IncidentRow[]>([])
  const [flows,     setFlows]     = useState<FlowRow[]>([])

  const [loading,      setLoading]      = useState(true)
  const [lastUpdated,  setLastUpdated]  = useState<Date | null>(null)
  const [secondsSince, setSecondsSince] = useState(0)

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch all data in parallel
  const loadAll = useCallback(async () => {
    try {
      const [ovRes, latRes, incRes, flRes] = await Promise.allSettled([
        fetch('/api/network/overview'),
        fetch('/api/network/latency?period=1h'),
        fetch('/api/network/incidents?status=all&limit=5'),
        fetch('/api/network/flows?period=15m&limit=100'),
      ])

      if (ovRes.status  === 'fulfilled' && ovRes.value.ok)  setOverview(await ovRes.value.json())
      if (latRes.status === 'fulfilled' && latRes.value.ok) setLatency(await latRes.value.json())
      if (incRes.status === 'fulfilled' && incRes.value.ok) setIncidents(await incRes.value.json())
      if (flRes.status  === 'fulfilled' && flRes.value.ok)  setFlows(await flRes.value.json())

      setLastUpdated(new Date())
      setSecondsSince(0)
    } catch { /* silent — individual failures handled per-endpoint */ }
    finally {
      setLoading(false)
    }
  }, [])

  // Initial load + 30s refresh
  useEffect(() => {
    loadAll()
    const id = setInterval(loadAll, 30_000)
    return () => clearInterval(id)
  }, [loadAll])

  // "Last updated X seconds ago" ticker
  useEffect(() => {
    tickRef.current = setInterval(() => setSecondsSince(s => s + 1), 1000)
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [])

  // ── Derived data ────────────────────────────────────────────────────────────

  // Latency chart data (last 60 points)
  const chartSeries = (latency?.series ?? []).slice(-60).map(row => ({
    ...row,
    label: new Date(row.time as string).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }))

  const targets = latency?.targets ?? []

  // Gateway sparkline (first target, last 30 points)
  const gatewayKey = targets.length > 0 ? `${sanitise(targets[0])}_rtt` : null
  const sparkData = gatewayKey
    ? (latency?.series ?? []).slice(-30).map(r => (r[gatewayKey] as number | null) ?? 0)
    : []

  const gatewayLatest = gatewayKey && chartSeries.length > 0
    ? (chartSeries[chartSeries.length - 1][gatewayKey] as number | null)
    : null

  // Worst open incident severity
  const SEV_ORDER = ['critical', 'high', 'medium', 'low']
  const openIncidents = incidents.filter(i => !i.resolved_at)
  const worstSev = openIncidents.reduce<string | null>((best, i) => {
    const bi = SEV_ORDER.indexOf(best ?? 'low')
    const ci = SEV_ORDER.indexOf(i.severity)
    return ci < bi ? i.severity : best
  }, null)

  // Top devices from flows (aggregate by IP)
  const deviceMap: Record<string, { hostname: string | null; sent: number; received: number }> = {}
  for (const f of flows) {
    if (f.src_ip) {
      if (!deviceMap[f.src_ip]) deviceMap[f.src_ip] = { hostname: f.src_hostname, sent: 0, received: 0 }
      deviceMap[f.src_ip].sent += f.bytes
    }
    if (f.dst_ip) {
      if (!deviceMap[f.dst_ip]) deviceMap[f.dst_ip] = { hostname: f.dst_hostname, sent: 0, received: 0 }
      deviceMap[f.dst_ip].received += f.bytes
    }
  }
  const topDevices = Object.entries(deviceMap)
    .map(([ip, d]) => ({ ip, ...d, total: d.sent + d.received }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
  const maxDeviceBytes = topDevices[0]?.total ?? 1

  // Health gauge sub-scores
  const wanOk       = overview?.wan.status === 'healthy'
  const portsOk     = (overview?.internal.error_ports ?? 0) === 0
  const collectorOk = overview?.collector.online ?? false

  // Collector offline: minutes since last seen
  const collectorOfflineMin = overview?.collector.last_seen
    ? Math.floor((Date.now() - new Date(overview.collector.last_seen).getTime()) / 60_000)
    : null

  // ── Card motion variants ────────────────────────────────────────────────────
  const cardVariants = {
    hidden:  { opacity: 0, y: 12 },
    visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.06, duration: 0.22 } }),
  }

  const card = (content: React.ReactNode, colour?: string, i = 0) => (
    <motion.div
      className="card"
      custom={i}
      initial="hidden"
      animate="visible"
      variants={cardVariants}
      style={{
        padding: '16px 18px',
        borderTop: colour ? `2px solid ${colour}` : undefined,
        boxShadow: colour ? `0 0 24px ${colour}18` : undefined,
        flex: '1 1 0',
        minWidth: 0,
        cursor: 'default',
      }}
    >
      {content}
    </motion.div>
  )

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{
      padding: 16, height: '100%', overflow: 'auto',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Globe size={16} color="var(--accent)" />
        </div>
        <div>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            Network Overview
          </h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            Infrastructure health — auto-refreshes every 30 s
          </p>
        </div>

        {/* Last updated */}
        {lastUpdated && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-dim)' }}>
            <Clock size={11} />
            Updated {secondsSince < 5 ? 'just now' : `${secondsSince}s ago`}
          </div>
        )}
      </div>

      {/* ── Collector offline banner ──────────────────────────────────────────── */}
      {overview && !overview.collector.online && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            padding: '10px 14px', borderRadius: 'var(--radius)',
            background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
            display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          }}
        >
          <AlertTriangle size={14} color="var(--amber)" />
          <span style={{ fontSize: 12, color: 'var(--amber)', fontWeight: 500 }}>
            Collector offline — last data received{' '}
            {collectorOfflineMin != null ? `${collectorOfflineMin} minute${collectorOfflineMin !== 1 ? 's' : ''} ago` : 'unknown'}.
            {' '}Network data may be stale. Start the collector to resume monitoring.
          </span>
        </motion.div>
      )}

      {/* ── Row 1: Status cards ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
        {loading && !overview ? (
          [1, 2, 3, 4].map(i => <SkeletonCard key={i} height={96} />)
        ) : overview ? (
          <>
            {/* WAN */}
            {card(
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <StatusDot status={overview.wan.status} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>WAN</span>
                  <Wifi size={11} color={statusColour(overview.wan.status)} style={{ marginLeft: 'auto' }} />
                </div>
                <p className="mono" style={{ fontSize: 26, fontWeight: 700, color: statusColour(overview.wan.status), margin: '0 0 2px', lineHeight: 1 }}>
                  {overview.wan.latency_ms != null ? `${overview.wan.latency_ms.toFixed(0)} ms` : '—'}
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
                  {overview.wan.packet_loss_pct != null
                    ? `${overview.wan.packet_loss_pct.toFixed(1)}% packet loss`
                    : 'No ping data'}
                </p>
              </>,
              statusColour(overview.wan.status), 0,
            )}

            {/* Internal */}
            {card(
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <StatusDot status={overview.internal.status} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Internal</span>
                  <Server size={11} color={statusColour(overview.internal.status)} style={{ marginLeft: 'auto' }} />
                </div>
                <p className="mono" style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-head)', margin: '0 0 2px', lineHeight: 1 }}>
                  {overview.internal.active_devices}
                </p>
                <p style={{ fontSize: 11, color: overview.internal.error_ports > 0 ? 'var(--amber)' : 'var(--text-dim)', margin: 0 }}>
                  {overview.internal.error_ports > 0
                    ? `${overview.internal.error_ports} port${overview.internal.error_ports !== 1 ? 's' : ''} with errors`
                    : 'No port errors'}
                </p>
              </>,
              statusColour(overview.internal.status), 1,
            )}

            {/* Gateway RTT + sparkline */}
            {card(
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Gateway RTT</span>
                  <Zap size={11} color="var(--green)" style={{ marginLeft: 'auto' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                  <p className="mono" style={{ fontSize: 26, fontWeight: 700, color: 'var(--green)', margin: 0, lineHeight: 1, flexShrink: 0 }}>
                    {gatewayLatest != null ? `${gatewayLatest.toFixed(1)} ms` : '—'}
                  </p>
                  <div style={{ flex: 1, minWidth: 60 }}>
                    <Sparkline data={sparkData} colour="#22c55e" />
                  </div>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 0' }}>
                  {targets[0] ?? 'No target data'}
                </p>
              </>,
              'var(--green)', 2,
            )}

            {/* Incidents */}
            {card(
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Incidents</span>
                  <AlertTriangle size={11} color={overview.open_incidents > 0 ? 'var(--red)' : 'var(--text-dim)'} style={{ marginLeft: 'auto' }} />
                </div>
                <p className="mono" style={{
                  fontSize: 26, fontWeight: 700, lineHeight: 1, margin: '0 0 2px',
                  color: overview.open_incidents > 0 ? 'var(--red)' : 'var(--green)',
                }}>
                  {overview.open_incidents}
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
                  {overview.open_incidents === 0
                    ? 'All clear'
                    : worstSev
                    ? `Worst: ${worstSev}`
                    : `open incident${overview.open_incidents !== 1 ? 's' : ''}`}
                </p>
              </>,
              overview.open_incidents > 0 ? 'var(--red)' : undefined, 3,
            )}
          </>
        ) : null}
      </div>

      {/* ── Row 2: Chart 60% + Top devices 40% ───────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>

        {/* Latency chart */}
        <div className="card" style={{ flex: '3 1 360px', padding: '14px 18px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', margin: 0 }}>Real-time Latency</p>
              <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '2px 0 0' }}>Last hour · 30-second buckets</p>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              {targets.slice(0, 5).map((t, i) => (
                <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-dim)' }}>
                  <span style={{ width: 8, height: 2, background: TARGET_COLOURS[i], display: 'inline-block', borderRadius: 1 }} />
                  {t}
                </span>
              ))}
            </div>
          </div>

          {loading && !latency ? (
            <div style={{ height: 220, background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius)', animation: 'pulse 1.4s ease-in-out infinite' }} />
          ) : chartSeries.length === 0 ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>No latency data — deploy the collector stack to begin.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartSeries} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: '#3d4260' }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9, fill: '#3d4260' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `${v}ms`}
                  domain={[0, (max: number) => Math.ceil(Math.max(max * 1.1, 20))]}
                />
                <ReTooltip content={<LatencyTooltip />} />
                <ReferenceLine y={50}  stroke="rgba(245,158,11,0.4)" strokeDasharray="4 3"
                  label={{ value: 'Warning', fill: 'rgba(245,158,11,0.6)', fontSize: 9, position: 'insideTopLeft' }} />
                <ReferenceLine y={150} stroke="rgba(239,68,68,0.4)" strokeDasharray="4 3"
                  label={{ value: 'Critical', fill: 'rgba(239,68,68,0.6)', fontSize: 9, position: 'insideTopLeft' }} />
                {targets.slice(0, 5).map((t, i) => (
                  <Line
                    key={t}
                    type="monotone"
                    dataKey={`${sanitise(t)}_rtt`}
                    name={t}
                    stroke={TARGET_COLOURS[i]}
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls={false}
                    activeDot={{ r: 3, fill: TARGET_COLOURS[i] }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top devices */}
        <div className="card" style={{ flex: '2 1 240px', padding: '14px 18px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', margin: 0 }}>Top Devices</p>
              <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '2px 0 0' }}>By traffic · last 15 min</p>
            </div>
            <Activity size={13} color="var(--text-dim)" />
          </div>

          {loading && !flows.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[1, 2, 3, 4].map(i => (
                <div key={i} style={{ height: 36, background: 'rgba(255,255,255,0.02)', borderRadius: 6, animation: 'pulse 1.4s ease-in-out infinite' }} />
              ))}
            </div>
          ) : topDevices.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120 }}>
              <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>No flow data yet.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {topDevices.map(d => {
                const pct = d.total / maxDeviceBytes
                const barColour = pct > 0.8 ? 'var(--red)' : pct > 0.5 ? 'var(--amber)' : 'var(--accent)'
                return (
                  <div
                    key={d.ip}
                    onClick={() => navigate(`/network/investigate?ip=${d.ip}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)' }}>
                        {d.hostname ?? d.ip}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace' }}>
                        {fmt(d.total)}
                      </span>
                    </div>
                    <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
                      <div style={{
                        width: `${pct * 100}%`, height: '100%',
                        background: barColour,
                        borderRadius: 2,
                        boxShadow: pct > 0.8 ? `0 0 4px ${barColour}` : undefined,
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                    {d.hostname && (
                      <p style={{ fontSize: 9, color: 'var(--text-dim)', margin: '2px 0 0', fontFamily: 'monospace' }}>{d.ip}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Row 3: Incidents 50% + Health score 50% ───────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>

        {/* Recent incidents */}
        <div className="card" style={{ flex: '1 1 280px', padding: '14px 18px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', margin: 0 }}>Recent Incidents</p>
            <button
              onClick={() => navigate('/network/investigate')}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 11, color: 'var(--accent)', background: 'none',
                border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              View all <ArrowRight size={11} />
            </button>
          </div>

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[1, 2, 3].map(i => <div key={i} style={{ height: 40, background: 'rgba(255,255,255,0.02)', borderRadius: 6, animation: 'pulse 1.4s ease-in-out infinite' }} />)}
            </div>
          ) : incidents.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 0' }}>
              <CheckCircle size={16} color="var(--green)" />
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>No incidents in the last 24 h</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {incidents.slice(0, 5).map(inc => (
                <div
                  key={inc.id}
                  style={{
                    padding: '8px 10px', borderRadius: 'var(--radius)',
                    background: 'rgba(255,255,255,0.02)',
                    borderLeft: `3px solid ${sevColour(inc.severity)}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <SeverityBadge severity={inc.severity} />
                    <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {inc.title}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 600, flexShrink: 0,
                      color: inc.resolved_at ? 'var(--green)' : 'var(--red)',
                    }}>
                      {inc.resolved_at ? 'resolved' : 'open'}
                    </span>
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '3px 0 0', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Clock size={9} />
                    {relTime(inc.started_at)}
                    {inc.affected_ip && <span style={{ marginLeft: 6, fontFamily: 'monospace' }}>{inc.affected_ip}</span>}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Health score */}
        <div className="card" style={{ flex: '1 1 280px', padding: '14px 18px', minWidth: 0 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', margin: '0 0 16px' }}>Health Score</p>

          {loading && !overview ? (
            <div style={{ height: 160, background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius)', animation: 'pulse 1.4s ease-in-out infinite' }} />
          ) : overview ? (
            <HealthGauge
              score={overview.health_score}
              wanOk={wanOk}
              portsOk={portsOk}
              collectorOk={collectorOk}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160 }}>
              <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>No data</p>
            </div>
          )}
        </div>
      </div>

    </div>
  )
}
