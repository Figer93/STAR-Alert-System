import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { AlertTriangle, WifiOff, X } from 'lucide-react'
import { getNetworkOverview, getOpenNetworkIncidents } from '../../lib/api'
import type { OpenIncidentRow } from '../../lib/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m ago`
}

function durSince(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  const m    = Math.floor(diff / 60)
  if (m < 1)  return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h < 24) return `${h}h ${r}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NetworkStatusBanners() {
  const location   = useLocation()
  const navigate   = useNavigate()
  const isNetwork  = location.pathname.startsWith('/network')

  const [collectorLastSeen, setCollectorLastSeen] = useState<string | null>(null)
  const [globalIncidents,   setGlobalIncidents]   = useState<OpenIncidentRow[]>([])

  // Per-session dismissals stored in sessionStorage
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem('star_dismissed_incidents')
      return new Set<string>(raw ? JSON.parse(raw) : [])
    } catch { return new Set() }
  })

  const fetchOverview = useCallback(async () => {
    try {
      const ov = await getNetworkOverview()
      setCollectorLastSeen(ov.collector.last_seen)
    } catch { /* silent — banners are best-effort */ }
  }, [])

  const fetchIncidents = useCallback(async () => {
    try {
      const rows = await getOpenNetworkIncidents()
      setGlobalIncidents(rows.filter(i => i.incident_scope === 'global'))
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    if (!isNetwork) return
    fetchOverview()
    fetchIncidents()
    const t1 = setInterval(fetchOverview,   30_000)
    const t2 = setInterval(fetchIncidents,  60_000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [isNetwork, fetchOverview, fetchIncidents])

  function dismiss(id: string) {
    const next = new Set(dismissedIds)
    next.add(id)
    setDismissedIds(next)
    try { sessionStorage.setItem('star_dismissed_incidents', JSON.stringify([...next])) } catch {}
  }

  if (!isNetwork) return null

  // ── Collector freshness ──────────────────────────────────────────────────────
  const ageS     = collectorLastSeen
    ? Math.floor((Date.now() - new Date(collectorLastSeen).getTime()) / 1000)
    : null
  const ageMin   = ageS !== null ? Math.floor(ageS / 60) : 0
  const isAmber  = ageS !== null && ageS > 300  && ageS <= 900   // >5min ≤15min
  const isRed    = ageS !== null && ageS > 900                    // >15min

  // ── Visible global incidents ─────────────────────────────────────────────────
  const visible = globalIncidents.filter(i => !dismissedIds.has(i.id))

  if (!isAmber && !isRed && visible.length === 0) return null

  return (
    <div>
      {/* 5A — Collector staleness */}
      {(isAmber || isRed) && (
        <div style={{
          padding:      '7px 20px',
          background:   isRed ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.08)',
          borderBottom: `1px solid ${isRed ? 'rgba(239,68,68,0.28)' : 'rgba(245,158,11,0.28)'}`,
          display:      'flex',
          alignItems:   'center',
          gap:          8,
          fontSize:     12,
          color:        isRed ? 'var(--red)' : 'var(--amber)',
        }}>
          <WifiOff size={13} style={{ flexShrink: 0 }} />
          <span>
            Collector offline — data may be stale.
            {' '}Last seen: {ageMin} minute{ageMin !== 1 ? 's' : ''} ago.
          </span>
        </div>
      )}

      {/* 5C — Global outage banners */}
      {visible.map(inc => (
        <div
          key={inc.id}
          style={{
            padding:      '7px 20px',
            background:   'rgba(239,68,68,0.10)',
            borderBottom: '1px solid rgba(239,68,68,0.28)',
            display:      'flex',
            alignItems:   'center',
            gap:          8,
            fontSize:     12,
            color:        'var(--red)',
          }}
        >
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            <strong>Global outage active:</strong>{' '}
            {inc.title}
            {' · '}started {relTime(inc.started_at)}
            {' · '}Duration: {durSince(inc.started_at)}
          </span>
          <button
            onClick={() => navigate('/network/incidents')}
            style={{
              background:   'none',
              border:       '1px solid rgba(239,68,68,0.4)',
              color:        'var(--red)',
              borderRadius: 4,
              padding:      '2px 8px',
              fontSize:     11,
              cursor:       'pointer',
              whiteSpace:   'nowrap',
              fontFamily:   'inherit',
            }}
          >
            View incident →
          </button>
          <button
            onClick={() => dismiss(inc.id)}
            title="Dismiss for this session"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: 2, flexShrink: 0 }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
