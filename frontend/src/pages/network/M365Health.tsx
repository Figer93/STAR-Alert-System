import { useCallback, useEffect, useState } from 'react'
import { Cloud } from 'lucide-react'
import { getM365Health, getM365Incidents, type M365ServiceHealth, type M365Incident } from '../../lib/api'

// ── Status classification ─────────────────────────────────────────────────────

type StatusClass = 'operational' | 'informational' | 'degraded' | 'incident'

const DEGRADED_STATUSES = new Set([
  'serviceDegraded',
  'serviceRestored',
  'extendedRecovery',
  'falsePositive',
  'investigationSuspended',
  'postIncidentReviewPublished',
])

function classifyStatus(status: string): StatusClass {
  if (status === 'serviceOperational') return 'operational'
  if (status === 'informational')      return 'informational'
  if (DEGRADED_STATUSES.has(status))   return 'degraded'
  return 'incident'
}

const STATUS_COLORS: Record<StatusClass, string> = {
  operational:   '#22c55e',
  informational: '#6b7280',
  degraded:      '#eab308',
  incident:      '#ef4444',
}

const STATUS_BG: Record<StatusClass, string> = {
  operational:   'rgba(34,197,94,0.08)',
  informational: 'rgba(107,114,128,0.08)',
  degraded:      'rgba(234,179,8,0.10)',
  incident:      'rgba(239,68,68,0.10)',
}

const STATUS_BORDER: Record<StatusClass, string> = {
  operational:   'rgba(34,197,94,0.2)',
  informational: 'rgba(107,114,128,0.2)',
  degraded:      'rgba(234,179,8,0.3)',
  incident:      'rgba(239,68,68,0.35)',
}

function humanStatus(status: string): string {
  const map: Record<string, string> = {
    serviceOperational:          'Operational',
    informational:               'Informational',
    serviceDegraded:             'Degraded',
    serviceInterruption:         'Interruption',
    extendedRecovery:            'Extended Recovery',
    serviceRestored:             'Restored',
    falsePositive:               'False Positive',
    investigationSuspended:      'Investigation Suspended',
    postIncidentReviewPublished: 'Post-Incident Review',
  }
  return map[status] ?? status
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(startIso: string | null): string {
  if (!startIso) return '--'
  const ms = Date.now() - new Date(startIso).getTime()
  if (ms < 0) return '--'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    const rh = h % 24
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`
  }
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ── Service card ──────────────────────────────────────────────────────────────

function ServiceCard({ svc }: { svc: M365ServiceHealth }) {
  const cls   = classifyStatus(svc.status)
  const color  = STATUS_COLORS[cls]
  const bg     = STATUS_BG[cls]
  const border = STATUS_BORDER[cls]

  return (
    <div style={{
      background:   bg,
      border:       `1px solid ${border}`,
      borderRadius: 8,
      padding:      '14px 16px',
      display:      'flex',
      alignItems:   'flex-start',
      gap:          10,
    }}>
      {/* Status dot */}
      <span style={{
        width: 8, height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        marginTop: 4,
        boxShadow: cls !== 'operational' && cls !== 'informational'
          ? `0 0 6px ${color}` : 'none',
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize:   13,
          fontWeight: 600,
          color:      'var(--text-primary)',
          marginBottom: 3,
          overflow:   'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {svc.service_name}
        </div>
        <div style={{ fontSize: 11, color, fontWeight: 500 }}>
          {humanStatus(svc.status)}
        </div>
      </div>
    </div>
  )
}

// ── Classification badge ──────────────────────────────────────────────────────

function ClassBadge({ classification }: { classification: string | null }) {
  const isIncident = (classification ?? '').toLowerCase() === 'incident'
  return (
    <span style={{
      display:      'inline-block',
      padding:      '2px 10px',
      borderRadius: 6,
      fontSize:     11,
      fontWeight:   600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      background:   isIncident ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
      border:       isIncident ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(234,179,8,0.4)',
      color:        isIncident ? '#ef4444' : '#eab308',
    }}>
      {classification ?? '--'}
    </span>
  )
}

// ── Last-refreshed indicator ──────────────────────────────────────────────────

function RefreshIndicator({ lastAt }: { lastAt: Date | null }) {
  const [label, setLabel] = useState('')

  useEffect(() => {
    const tick = () => {
      if (!lastAt) { setLabel(''); return }
      const s = Math.floor((Date.now() - lastAt.getTime()) / 1000)
      if (s < 5)   setLabel('just now')
      else if (s < 60) setLabel(`${s}s ago`)
      else         setLabel(`${Math.floor(s / 60)}m ago`)
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [lastAt])

  if (!label) return null
  return (
    <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
      Refreshed {label}
    </span>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function M365Health() {
  const [services,  setServices]  = useState<M365ServiceHealth[]>([])
  const [incidents, setIncidents] = useState<M365Incident[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [lastAt,    setLastAt]    = useState<Date | null>(null)

  const fetchData = useCallback(() => {
    Promise.all([getM365Health(), getM365Incidents(false)])
      .then(([s, i]) => {
        setServices(s)
        setIncidents(i)
        setLoading(false)
        setError(null)
        setLastAt(new Date())
      })
      .catch(() => {
        setError('Failed to load M365 health data')
        setLoading(false)
      })
  }, [])

  // Initial load + 60-second auto-refresh
  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 60_000)
    return () => clearInterval(id)
  }, [fetchData])

  // Derived counts
  const issueCount = services.filter(s => !_OPERATIONAL_STATUSES.has(s.status)).length

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1300, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <Cloud size={22} color="var(--accent)" />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            M365 Health
          </h1>
          {!loading && !error && (
            <span style={{
              display:    'inline-block',
              padding:    '2px 10px',
              borderRadius: 6,
              fontSize:   12,
              fontWeight: 600,
              background: issueCount > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)',
              border:     issueCount > 0 ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(34,197,94,0.3)',
              color:      issueCount > 0 ? '#ef4444' : '#22c55e',
            }}>
              {issueCount > 0 ? `${issueCount} service${issueCount !== 1 ? 's' : ''} affected` : 'All operational'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            Microsoft 365 service health synced every 5 minutes.
          </p>
          <RefreshIndicator lastAt={lastAt} />
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
          Loading M365 health data…
        </div>
      ) : error ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#ef4444', fontSize: 14 }}>
          {error}
        </div>
      ) : (
        <>
          {/* Service grid */}
          {services.length === 0 ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
              No service health data yet — M365 sync may not have run.
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 32,
            }}>
              {services.map(svc => (
                <ServiceCard key={svc.service_id} svc={svc} />
              ))}
            </div>
          )}

          {/* Active incidents */}
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-head)', margin: 0 }}>
              Active Incidents &amp; Advisories
            </h2>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            {incidents.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                No active incidents or advisories.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Title', 'Service', 'Type', 'Status', 'Started', 'Duration'].map(h => (
                        <th
                          key={h}
                          style={{
                            padding:       '11px 16px',
                            textAlign:     'left',
                            fontWeight:    600,
                            fontSize:      11,
                            color:         'var(--text-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.07em',
                            whiteSpace:    'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {incidents.map(inc => (
                      <tr
                        key={inc.incident_id}
                        style={{ borderBottom: '1px solid var(--border-dim)' }}
                      >
                        <td style={{
                          padding:   '12px 16px',
                          fontWeight: 500,
                          color:     'var(--text-primary)',
                          maxWidth:  320,
                        }}>
                          <div style={{
                            overflow:     'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace:   'nowrap',
                          }}>
                            {inc.title ?? '--'}
                          </div>
                        </td>
                        <td style={{
                          padding:   '12px 16px',
                          color:     'var(--text-muted)',
                          fontSize:  12,
                          whiteSpace: 'nowrap',
                        }}>
                          {inc.service_name ?? '--'}
                        </td>
                        <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                          <ClassBadge classification={inc.classification} />
                        </td>
                        <td style={{
                          padding:   '12px 16px',
                          color:     'var(--text-muted)',
                          fontSize:  12,
                          whiteSpace: 'nowrap',
                        }}>
                          {inc.status ?? '--'}
                        </td>
                        <td style={{
                          padding:   '12px 16px',
                          color:     'var(--text-dim)',
                          fontSize:  12,
                          whiteSpace: 'nowrap',
                        }}>
                          {fmtDate(inc.start_time)}
                        </td>
                        <td style={{
                          padding:    '12px 16px',
                          fontSize:   12,
                          fontWeight: 600,
                          color:      inc.is_resolved ? 'var(--text-dim)' : '#eab308',
                          whiteSpace: 'nowrap',
                        }}>
                          {fmtDuration(inc.start_time)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Module-level set used by the page (avoids recomputing per-render)
const _OPERATIONAL_STATUSES = new Set(['serviceOperational', 'informational'])
