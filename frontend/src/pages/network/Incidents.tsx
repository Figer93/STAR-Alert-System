import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, X, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import SeverityBadge from '../../components/network/SeverityBadge'
import { resolveIncident, getNetworkIncidents } from '../../lib/api'

// ── Types ──────────────────────────────────────────────────────────────────────

interface IncidentRow {
  id:                 string
  started_at:         string
  resolved_at:        string | null
  severity:           string
  category:           string
  affected_ip:        string | null
  affected_switch:    string | null
  affected_port:      string | null
  title:              string
  description:        string | null
  evidence:           Record<string, unknown> | null
  root_cause:         string | null
  resolution_notes:   string | null
  auto_detected:      boolean
  incident_scope:     string
  affected_component: string | null
}

type StatusFilter = 'open' | 'resolved' | 'all'

// ── Helpers ────────────────────────────────────────────────────────────────────

function dur(startIso: string, endIso: string | null): string {
  const endMs = endIso ? new Date(endIso).getTime() : Date.now()
  const ms    = endMs - new Date(startIso).getTime()
  const m     = Math.floor(ms / 60000)
  if (m < 1)  return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h < 24) return `${h}h ${r}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function calcMttr(incidents: IncidentRow[]): string | null {
  const resolved = incidents.filter(i => i.resolved_at)
  if (resolved.length === 0) return null
  const avgMs = resolved.reduce((sum, i) => {
    return sum + new Date(i.resolved_at!).getTime() - new Date(i.started_at).getTime()
  }, 0) / resolved.length
  const m = Math.floor(avgMs / 60000)
  if (m < 60)  return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return `${h}h ${r}m`
}

// ── Detail / Resolve panel ─────────────────────────────────────────────────────

function IncidentPanel({
  incident,
  onClose,
  onResolved,
}: {
  incident: IncidentRow
  onClose:  () => void
  onResolved: (updated: IncidentRow) => void
}) {
  const navigate  = useNavigate()
  const panelRef  = useRef<HTMLDivElement | null>(null)

  const [resolving, setResolving]   = useState(false)
  const [rootCause, setRootCause]   = useState(incident.root_cause ?? '')
  const [notes, setNotes]           = useState(incident.resolution_notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [evOpen, setEvOpen]         = useState(true)

  const isOpen = !incident.resolved_at

  // Click-outside
  useEffect(() => {
    function h(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])

  // Escape
  useEffect(() => {
    function h(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  async function submitResolve() {
    setSubmitting(true)
    setResolveErr(null)
    try {
      const updated: IncidentRow = await resolveIncident(incident.id, {
        root_cause:       rootCause.trim() || null,
        resolution_notes: notes.trim()     || null,
      })
      onResolved(updated)
      setResolving(false)
    } catch (e) {
      setResolveErr(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const sevColor = incident.severity === 'critical' ? 'var(--red)'
    : incident.severity === 'high'   ? '#f97316'
    : incident.severity === 'medium' ? 'var(--amber)'
    : 'var(--green)'

  const evidence = incident.evidence ? Object.entries(incident.evidence) : []

  return (
    <motion.div
      ref={panelRef}
      initial={{ x: 420, opacity: 0 }}
      animate={{ x: 0,   opacity: 1 }}
      exit={{   x: 420, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      style={{
        position: 'fixed',
        top: 0, right: 0, bottom: 0,
        width: 420,
        background: 'var(--bg-surface)',
        borderLeft: `3px solid ${sevColor}`,
        display: 'flex', flexDirection: 'column',
        zIndex: 50, overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <SeverityBadge severity={incident.severity} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {incident.category.replace(/_/g, ' ')}
              </span>
            </div>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-head)', margin: 0, lineHeight: 1.4 }}>
              {incident.title}
            </h3>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Meta */}
          <section>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
              {[
                ['Status',      incident.resolved_at ? 'Resolved' : 'Open'],
                ['Started',     fmtDate(incident.started_at)],
                ['Duration',    dur(incident.started_at, incident.resolved_at)],
                ...(incident.resolved_at ? [['Resolved', fmtDate(incident.resolved_at)]] : []),
                ...(incident.affected_ip ? [['Affected IP', incident.affected_ip]] : []),
                ...(incident.affected_switch ? [['Switch', incident.affected_switch]] : []),
                ...(incident.affected_port ? [['Port', incident.affected_port]] : []),
                ['Auto-detected', incident.auto_detected ? 'Yes' : 'No'],
              ].map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</div>
                  <div style={{ fontSize: 13, color: k === 'Status' ? (incident.resolved_at ? 'var(--green)' : 'var(--red)') : 'var(--text-primary)' }}>{v as string}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Description */}
          {incident.description && (
            <section>
              <h4 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 6 }}>Description</h4>
              <p style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5, margin: 0 }}>{incident.description}</p>
            </section>
          )}

          {/* Evidence */}
          {evidence.length > 0 && (
            <section>
              <button
                onClick={() => setEvOpen(o => !o)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600,
                  marginBottom: evOpen ? 8 : 0,
                }}
              >
                Evidence
                {evOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
              {evOpen && (
                <div style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '10px 14px',
                  fontSize: 12,
                }}>
                  {evidence.map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 10, marginBottom: 5, lineHeight: 1.4 }}>
                      <span style={{ color: 'var(--text-muted)', flexShrink: 0, minWidth: 120 }}>{k}:</span>
                      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Root cause / resolution (if resolved) */}
          {incident.resolved_at && (
            <section>
              <h4 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 8 }}>Resolution</h4>
              {incident.root_cause && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Root cause</div>
                  <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: 0 }}>{incident.root_cause}</p>
                </div>
              )}
              {incident.resolution_notes && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Notes</div>
                  <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: 0 }}>{incident.resolution_notes}</p>
                </div>
              )}
            </section>
          )}

          {/* Investigate link */}
          {incident.affected_ip && (
            <button
              onClick={() => navigate(`/network/investigate?ip=${encodeURIComponent(incident.affected_ip!)}`)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                width: '100%', padding: '9px',
                background: 'var(--bg-base)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', borderRadius: 7, cursor: 'pointer',
                fontSize: 13, fontWeight: 500,
              }}
            >
              <ExternalLink size={13} /> Investigate {incident.affected_ip}
            </button>
          )}

          {/* Resolve section */}
          {isOpen && (
            <section style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              {!resolving ? (
                <button
                  onClick={() => setResolving(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    width: '100%', padding: '9px', justifyContent: 'center',
                    background: 'rgba(34,197,94,0.10)',
                    border: '1px solid rgba(34,197,94,0.30)',
                    color: 'var(--green)', borderRadius: 7, cursor: 'pointer',
                    fontSize: 13, fontWeight: 600,
                  }}
                >
                  <CheckCircle2 size={14} /> Mark as resolved
                </button>
              ) : (
                <div>
                  <h4 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', marginBottom: 12 }}>Resolve incident</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Root cause (optional)</label>
                      <input
                        value={rootCause}
                        onChange={e => setRootCause(e.target.value)}
                        placeholder="e.g. Faulty patch cable replaced"
                        style={{
                          width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border)',
                          color: 'var(--text-primary)', borderRadius: 6, padding: '7px 10px',
                          fontSize: 13, boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Resolution notes (optional)</label>
                      <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        rows={3}
                        placeholder="Describe what was done to resolve this..."
                        style={{
                          width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border)',
                          color: 'var(--text-primary)', borderRadius: 6, padding: '7px 10px',
                          fontSize: 13, resize: 'vertical', fontFamily: 'inherit',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    {resolveErr && <p style={{ color: 'var(--red)', fontSize: 12, margin: 0 }}>{resolveErr}</p>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={submitResolve}
                        disabled={submitting}
                        style={{
                          flex: 1, padding: '8px', background: 'var(--green)', color: '#fff',
                          border: 'none', borderRadius: 6, cursor: submitting ? 'wait' : 'pointer',
                          fontSize: 13, fontWeight: 600, opacity: submitting ? 0.7 : 1,
                        }}
                      >
                        {submitting ? 'Resolving…' : 'Confirm resolve'}
                      </button>
                      <button
                        onClick={() => setResolving(false)}
                        style={{
                          flex: 1, padding: '8px', background: 'none',
                          border: '1px solid var(--border)', color: 'var(--text-muted)',
                          borderRadius: 6, cursor: 'pointer', fontSize: 13,
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

        </div>
      </div>
    </motion.div>
  )
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ incidents }: { incidents: IncidentRow[] }) {
  const now       = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const thisMonth = incidents.filter(i => new Date(i.started_at) >= monthStart)
  const openCount = incidents.filter(i => !i.resolved_at).length
  const critOpen  = incidents.filter(i => !i.resolved_at && i.severity === 'critical').length
  const mttr      = calcMttr(thisMonth.filter(i => i.resolved_at !== null))

  const byCategory = useMemo(() => {
    const m: Record<string, number> = {}
    thisMonth.forEach(i => { m[i.category] = (m[i.category] ?? 0) + 1 })
    return Object.entries(m).sort(([, a], [, b]) => b - a).slice(0, 3)
  }, [thisMonth])

  const stats: Array<{ label: string; value: string; color?: string }> = [
    { label: 'Open incidents',   value: String(openCount),  color: openCount  > 0 ? 'var(--amber)' : 'var(--green)' },
    { label: 'Critical open',    value: String(critOpen),   color: critOpen   > 0 ? 'var(--red)'   : 'var(--text-muted)' },
    { label: 'This month',       value: String(thisMonth.length) },
    { label: 'MTTR this month',  value: mttr ?? '—' },
    ...byCategory.map(([cat, n]) => ({ label: cat.replace(/_/g, ' '), value: String(n) })),
  ]

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
      {stats.map(s => (
        <div key={s.label} style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '10px 16px',
          minWidth: 110,
        }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: s.color ?? 'var(--text-head)', lineHeight: 1 }}>{s.value}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textTransform: 'capitalize' }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Incidents() {
  const [incidents, setIncidents]       = useState<IncidentRow[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [selected, setSelected]         = useState<IncidentRow | null>(null)

  const load = useCallback((filter: StatusFilter) => {
    setLoading(true)
    setError(null)
    getNetworkIncidents(filter, 200)
      .then(rows => setIncidents(rows as IncidentRow[]))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(statusFilter) }, [load, statusFilter])

  // Also load "all" for stats (keep separate)
  const [allIncidents, setAllIncidents] = useState<IncidentRow[]>([])
  useEffect(() => {
    getNetworkIncidents('all', 500)
      .then(rows => setAllIncidents(rows as IncidentRow[]))
      .catch(() => {})
  }, [])

  function handleResolved(updated: IncidentRow) {
    setIncidents(prev => prev.map(i => i.id === updated.id ? updated : i))
    setAllIncidents(prev => prev.map(i => i.id === updated.id ? updated : i))
    setSelected(updated)
  }

  const filterTabs: { key: StatusFilter; label: string }[] = [
    { key: 'open',     label: 'Open' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'all',      label: 'All' },
  ]

  const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

  const sorted = useMemo(() =>
    [...incidents].sort((a, b) => {
      const so = (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9)
      if (so !== 0) return so
      return new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    }),
  [incidents])

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--radius)',
          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <AlertTriangle size={17} color="var(--red)" />
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>Incidents</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, marginBottom: 0 }}>
            Network health incidents detected and tracked automatically
          </p>
        </div>
      </div>

      {/* Stats */}
      {allIncidents.length > 0 && <StatsBar incidents={allIncidents} />}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setStatusFilter(tab.key); setSelected(null) }}
            style={{
              padding: '8px 18px',
              background: 'none',
              border: 'none',
              borderBottom: statusFilter === tab.key ? '2px solid var(--blue)' : '2px solid transparent',
              color: statusFilter === tab.key ? 'var(--blue)' : 'var(--text-muted)',
              fontWeight: statusFilter === tab.key ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: -1,
              transition: 'color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 8, padding: '12px 16px', color: 'var(--red)',
          fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && incidents.length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 32px', color: 'var(--text-muted)' }}>
          {statusFilter === 'open' ? (
            <>
              <CheckCircle2 size={40} style={{ margin: '0 auto 16px', display: 'block', color: 'var(--green)' }} />
              <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>All clear</h3>
              <p style={{ fontSize: 13 }}>No open incidents. Network is healthy.</p>
            </>
          ) : (
            <p style={{ fontSize: 13 }}>No incidents found for this filter.</p>
          )}
        </div>
      )}

      {/* Table */}
      {(loading || sorted.length > 0) && (
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-base)' }}>
                {['Severity', 'Title', 'Category', 'Started', 'Duration', 'Status', 'Root Cause'].map(h => (
                  <th key={h} style={{
                    padding: '10px 14px', textAlign: 'left', fontSize: 11,
                    fontWeight: 600, color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && incidents.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ height: 12, borderRadius: 3, background: 'var(--bg-base)', width: j === 1 ? '70%' : '50%', animation: 'pulse 1.5s infinite' }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                sorted.map(inc => {
                  const isSelected = selected?.id === inc.id
                  const isResolved = !!inc.resolved_at
                  return (
                    <tr
                      key={inc.id}
                      onClick={() => setSelected(isSelected ? null : inc)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(59,130,246,0.07)' : 'transparent',
                        borderLeft: isSelected ? '3px solid var(--blue)' : '3px solid transparent',
                        opacity: isResolved ? 0.7 : 1,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.03)' }}
                      onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                    >
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
                        <SeverityBadge severity={inc.severity} small />
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', maxWidth: 320 }}>
                        <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {inc.title}
                        </div>
                        {inc.affected_ip && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>{inc.affected_ip}</div>
                        )}
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
                        {inc.category.replace(/_/g, ' ')}
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {fmtDate(inc.started_at)}
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {dur(inc.started_at, inc.resolved_at)}
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
                        <span style={{
                          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          color: isResolved ? 'var(--green)' : 'var(--amber)',
                        }}>
                          {isResolved ? 'Resolved' : 'Open'}
                        </span>
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', maxWidth: 200 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {inc.root_cause ?? '—'}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>

          {sorted.length > 0 && (
            <div style={{
              padding: '9px 16px', borderTop: '1px solid var(--border)',
              fontSize: 12, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{sorted.length} incident{sorted.length !== 1 ? 's' : ''}</span>
              <span>{sorted.filter(i => !i.resolved_at).length} open · {sorted.filter(i => i.resolved_at).length} resolved</span>
            </div>
          )}
        </div>
      )}

      {/* Detail panel */}
      <AnimatePresence>
        {selected && (
          <IncidentPanel
            key={selected.id}
            incident={selected}
            onClose={() => setSelected(null)}
            onResolved={handleResolved}
          />
        )}
      </AnimatePresence>

    </div>
  )
}
