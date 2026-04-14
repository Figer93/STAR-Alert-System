import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Activity, Database, Radio, Train } from 'lucide-react'
import {
  getDbHealth,
  getCollectorHeartbeatLatest,
  getRailwayStatus,
  type DbHealthData,
  type CollectorHeartbeatLatest,
  type RailwayStatusData,
} from '../../lib/api'

// ── Types ──────────────────────────────────────────────────────────────────────

type StatusLevel = 'green' | 'amber' | 'red'

interface ApiState {
  latency_ms: number | null
  status: 'ok' | 'error' | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`
  return `${bytes} B`
}

function minutesAgo(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
}

const DOT_COLOR: Record<StatusLevel, string> = {
  green: 'var(--green)',
  amber: 'var(--amber)',
  red:   'var(--red)',
}

const CARD_BORDER: Record<StatusLevel, string> = {
  green: 'rgba(34,197,94,0.18)',
  amber: 'rgba(245,158,11,0.18)',
  red:   'rgba(239,68,68,0.18)',
}

const CARD_BG: Record<StatusLevel, string> = {
  green: 'rgba(34,197,94,0.06)',
  amber: 'rgba(245,158,11,0.06)',
  red:   'rgba(239,68,68,0.06)',
}

// ── StatusDot ──────────────────────────────────────────────────────────────────

function StatusDot({ level }: { level: StatusLevel }) {
  return (
    <span style={{
      width: 8, height: 8,
      borderRadius: '50%',
      background: DOT_COLOR[level],
      display: 'inline-block',
      flexShrink: 0,
      boxShadow: `0 0 5px ${DOT_COLOR[level]}`,
    }} />
  )
}

// ── Card wrapper ───────────────────────────────────────────────────────────────

interface HealthCardProps {
  title:    string
  icon:     React.ElementType
  level:    StatusLevel
  loading?: boolean
  children: React.ReactNode
}

function HealthCard({ title, icon: Icon, level, loading, children }: HealthCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      style={{
        background: `radial-gradient(ellipse at top left, ${CARD_BG[level]} 0%, transparent 70%), var(--bg-surface)`,
        border: `1px solid ${CARD_BORDER[level]}`,
        borderTop: `2px solid ${DOT_COLOR[level]}`,
        borderRadius: 'var(--radius-lg)',
        padding: '16px 18px',
        position: 'relative',
        minHeight: 140,
        opacity: loading ? 0.6 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={14} style={{ color: 'var(--text-dim)' }} />
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--text-dim)',
          }}>
            {title}
          </span>
        </div>
        <StatusDot level={level} />
      </div>

      {children}
    </motion.div>
  )
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function ProgressBar({ value, max, level }: { value: number; max: number; level: StatusLevel }) {
  const pct = Math.min((value / max) * 100, 100)
  return (
    <div style={{
      height: 6, borderRadius: 3, background: 'var(--bg-elevated)',
      overflow: 'hidden', marginBottom: 4,
    }}>
      <div style={{
        height: '100%', width: `${pct}%`,
        background: DOT_COLOR[level],
        transition: 'width 0.4s ease',
        borderRadius: 3,
      }} />
    </div>
  )
}

// ── Mono value ─────────────────────────────────────────────────────────────────

function MonoValue({ children, colour }: { children: React.ReactNode; colour?: string }) {
  return (
    <span style={{
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 26, fontWeight: 700, lineHeight: 1,
      color: colour ?? 'var(--text-head)',
    }}>
      {children}
    </span>
  )
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
      {children}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function SystemHealth() {
  const [apiState,       setApiState]       = useState<ApiState>({ latency_ms: null, status: null })
  const [dbData,         setDbData]         = useState<DbHealthData | null>(null)
  const [collectorData,  setCollectorData]  = useState<CollectorHeartbeatLatest | null>(null)
  const [railwayData,    setRailwayData]    = useState<RailwayStatusData | null>(null)
  const [loading,        setLoading]        = useState(true)

  async function fetchAll() {
    // Measure backend latency via /health
    let latency: number | null = null
    let apiStatus: 'ok' | 'error' = 'ok'
    try {
      const t0 = performance.now()
      await fetch('/health')
      latency = Math.round(performance.now() - t0)
    } catch {
      apiStatus = 'error'
    }
    setApiState({ latency_ms: latency, status: apiStatus })

    try {
      const [db, collector, railway] = await Promise.allSettled([
        getDbHealth(),
        getCollectorHeartbeatLatest(),
        getRailwayStatus(),
      ])
      if (db.status        === 'fulfilled') setDbData(db.value)
      if (collector.status === 'fulfilled') setCollectorData(collector.value)
      if (railway.status   === 'fulfilled') setRailwayData(railway.value)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
    const id = setInterval(fetchAll, 30_000)
    return () => clearInterval(id)
  }, [])

  // ── Compute status levels ──────────────────────────────────────────────────

  function apiLevel(): StatusLevel {
    if (apiState.status === 'error') return 'red'
    const ms = apiState.latency_ms
    if (ms === null) return 'amber'
    if (ms < 300)   return 'green'
    if (ms < 800)   return 'amber'
    return 'red'
  }

  function dbLevel(): StatusLevel {
    if (!dbData) return 'amber'
    const pct = dbData.size_bytes / dbData.limit_bytes
    if (pct >= 0.9) return 'red'
    if (pct >= 0.7) return 'amber'
    return 'green'
  }

  function collectorLevel(): StatusLevel {
    const mins = minutesAgo(collectorData?.last_seen ?? null)
    if (mins === null) return 'amber'
    if (mins < 5)  return 'green'
    if (mins < 15) return 'amber'
    return 'red'
  }

  function railwayLevel(): StatusLevel {
    if (!railwayData) return 'amber'
    return railwayData.status === 'healthy' ? 'green' : 'red'
  }

  // ── Derived display values ─────────────────────────────────────────────────

  const dbPct = dbData ? Math.min((dbData.size_bytes / dbData.limit_bytes) * 100, 100) : 0

  const collectorMins = minutesAgo(collectorData?.last_seen ?? null)
  const collectorText = collectorMins === null
    ? 'No data'
    : collectorMins < 1 ? 'just now'
    : `${collectorMins}m ago`

  return (
    <div style={{ padding: '24px 28px', maxWidth: 900 }}>
      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-head)', marginBottom: 4 }}>
          System Health
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Live status for all infrastructure components · refreshes every 30 s
        </div>
      </div>

      {/* 2×2 grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16,
      }}>

        {/* Card 1 — Backend API */}
        <HealthCard title="Backend API" icon={Activity} level={apiLevel()} loading={loading}>
          <MonoValue colour={DOT_COLOR[apiLevel()]}>
            {apiState.latency_ms !== null ? `${apiState.latency_ms} ms` : '—'}
          </MonoValue>
          <SubLabel>
            {apiState.status === 'error'
              ? 'Backend unreachable'
              : apiState.latency_ms !== null
                ? apiLevel() === 'green' ? 'Response time · healthy'
                : apiLevel() === 'amber' ? 'Response time · elevated'
                : 'Response time · high'
              : 'Measuring…'}
          </SubLabel>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <StatusDot level={apiState.status === 'ok' ? 'green' : 'red'} />
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
              {apiState.status === 'ok' ? 'OK' : apiState.status === 'error' ? 'ERROR' : '—'}
            </span>
          </div>
        </HealthCard>

        {/* Card 2 — Database */}
        <HealthCard title="Database" icon={Database} level={dbLevel()} loading={loading}>
          <MonoValue colour={DOT_COLOR[dbLevel()]}>
            {dbData ? `${dbPct.toFixed(1)}%` : '—'}
          </MonoValue>
          <SubLabel>
            {dbData
              ? `${fmtBytes(dbData.size_bytes)} of ${fmtBytes(dbData.limit_bytes)} used`
              : 'Loading…'}
          </SubLabel>

          {dbData && (
            <div style={{ marginTop: 10 }}>
              <ProgressBar value={dbData.size_bytes} max={dbData.limit_bytes} level={dbLevel()} />
            </div>
          )}

          {/* Top tables */}
          {dbData && (
            <div style={{ marginTop: 10 }}>
              {dbData.top_tables.map(t => (
                <div key={t.name} style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 11, color: 'var(--text-dim)',
                  padding: '2px 0',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                    {t.name}
                  </span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
                    {fmtBytes(t.size_bytes)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {dbData && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
              {dbData.connections} active connection{dbData.connections !== 1 ? 's' : ''}
            </div>
          )}
        </HealthCard>

        {/* Card 3 — Collector */}
        <HealthCard title="Collector" icon={Radio} level={collectorLevel()} loading={loading}>
          <MonoValue colour={DOT_COLOR[collectorLevel()]}>
            {collectorText}
          </MonoValue>
          <SubLabel>
            {collectorData?.last_seen
              ? new Date(collectorData.last_seen).toLocaleString()
              : 'No heartbeat recorded'}
          </SubLabel>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusDot level={collectorLevel()} />
              <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                {collectorLevel() === 'green' ? 'online'
                : collectorLevel() === 'amber' ? 'degraded'
                : 'offline'}
              </span>
            </div>
            {collectorData?.collector_version && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                v{collectorData.collector_version}
              </div>
            )}
          </div>
        </HealthCard>

        {/* Card 4 — Railway */}
        <HealthCard title="Railway" icon={Train} level={railwayLevel()} loading={loading}>
          <MonoValue colour={DOT_COLOR[railwayLevel()]}>
            {railwayData?.deployment ?? '—'}
          </MonoValue>
          <SubLabel>
            {railwayData ? `Deployment SHA (last 7)` : 'Loading…'}
          </SubLabel>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <StatusDot level={railwayLevel()} />
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
              {railwayData?.status ?? '—'}
            </span>
          </div>
        </HealthCard>

      </div>
    </div>
  )
}
