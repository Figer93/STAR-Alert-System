import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Download, ChevronUp, ChevronDown, BellOff, X } from 'lucide-react'
import type { Alert, Source } from '../types'
import { getAlerts, acknowledgeAlert, resolveAlert, exportAlertsCsv } from '../lib/api'
import { getSources } from '../lib/api'
import AlertDetail from '../components/alerts/AlertDetail'

function relativeTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

const SEV_COLOUR: Record<string, string> = {
  critical: 'var(--red)', warning: 'var(--amber)', info: 'var(--blue)', ok: 'var(--green)',
}
const SEV_BG: Record<string, string> = {
  critical: 'rgba(239,68,68,0.10)', warning: 'rgba(245,158,11,0.10)',
  info:     'rgba(59,130,246,0.10)', ok:     'rgba(34,197,94,0.10)',
}
const STATUS_COLOUR: Record<string, string> = {
  active:       'var(--blue)',
  acknowledged: 'var(--green)',
  resolved:     'var(--text-dim)',
}
const STATUS_BG: Record<string, string> = {
  active:       'rgba(59,130,246,0.10)',
  acknowledged: 'rgba(34,197,94,0.10)',
  resolved:     'rgba(100,116,139,0.08)',
}

type SortKey = 'severity' | 'source' | 'title' | 'status' | 'when' | 'count'

const SEV_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2, ok: 3 }

const ghostSelect: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 6,
  color: 'var(--text-muted)',
  fontSize: 12,
  fontWeight: 500,
  padding: '5px 9px',
  cursor: 'pointer',
  outline: 'none',
}

export default function AlertHistory() {
  const [alerts, setAlerts]           = useState<Alert[]>([])
  const [sources, setSources]         = useState<Source[]>([])
  const [loading, setLoading]         = useState(true)
  const [search, setSearch]           = useState('')
  const [sevFilter, setSevFilter]     = useState('')
  const [srcFilter, setSrcFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [detail, setDetail]           = useState<Alert | null>(null)
  const [sortKey, setSortKey]         = useState<SortKey>('when')
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('desc')

  useEffect(() => {
    Promise.all([getAlerts({ limit: 500 }), getSources()])
      .then(([r, s]) => { setAlerts(r.alerts); setSources(s) })
      .finally(() => setLoading(false))
  }, [])

  const hasFilters = !!(search || sevFilter || srcFilter || statusFilter)

  const clearFilters = () => {
    setSearch(''); setSevFilter(''); setSrcFilter(''); setStatusFilter('')
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    let result = alerts.filter(a => {
      if (sevFilter && a.severity !== sevFilter) return false
      if (srcFilter && a.source?.slug !== srcFilter) return false
      if (statusFilter && a.status !== statusFilter) return false
      if (q && !a.title.toLowerCase().includes(q) && !a.message.toLowerCase().includes(q)) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'severity') cmp = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
      else if (sortKey === 'source') cmp = (a.source?.name ?? '').localeCompare(b.source?.name ?? '')
      else if (sortKey === 'title') cmp = a.title.localeCompare(b.title)
      else if (sortKey === 'status') cmp = a.status.localeCompare(b.status)
      else if (sortKey === 'when') cmp = new Date(a.first_seen).getTime() - new Date(b.first_seen).getTime()
      else if (sortKey === 'count') cmp = a.occurrence_count - b.occurrence_count
      return sortDir === 'asc' ? cmp : -cmp
    })

    return result
  }, [alerts, search, sevFilter, srcFilter, statusFilter, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const handleAck = async (a: Alert) => {
    await acknowledgeAlert(a.id).catch(() => {})
    setAlerts(prev => prev.map(x => x.id === a.id
      ? { ...x, status: 'acknowledged', acknowledged_by: 'dashboard' }
      : x))
  }

  const handleResolve = async (a: Alert) => {
    await resolveAlert(a.id).catch(() => {})
    setAlerts(prev => prev.map(x => x.id === a.id ? { ...x, status: 'resolved' } : x))
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronUp size={11} style={{ opacity: 0.3 }} />
    return sortDir === 'asc'
      ? <ChevronUp   size={11} style={{ color: 'var(--accent)' }} />
      : <ChevronDown size={11} style={{ color: 'var(--accent)' }} />
  }

  const cols: { key: SortKey; label: string; w?: string }[] = [
    { key: 'severity', label: 'Severity', w: '100px' },
    { key: 'source',   label: 'Source',   w: '120px' },
    { key: 'title',    label: 'Title' },
    { key: 'status',   label: 'Status',   w: '110px' },
    { key: 'when',     label: 'When',     w: '90px'  },
    { key: 'count',    label: 'Count',    w: '60px'  },
  ]

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--text-head)', fontWeight: 600, fontSize: 14 }}>
            Alert History
          </span>
          <span style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-bright)',
            borderRadius: 10, padding: '1px 8px',
            fontSize: 11, fontWeight: 700, color: 'var(--text-head)',
          }}>
            {filtered.length}
          </span>
        </div>
        <button
          onClick={exportAlertsCsv}
          title="Export CSV"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            ...ghostSelect, padding: '5px 11px',
          }}
        >
          <Download size={13} />
          Export CSV
        </button>
      </div>

      {/* Filters bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', flexShrink: 0 }}>
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{
            position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-dim)', pointerEvents: 'none',
          }} />
          <input
            placeholder="Search title / message…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              ...ghostSelect,
              paddingLeft: 28, minWidth: 200,
              color: 'var(--text-head)',
            }}
          />
        </div>

        <select style={ghostSelect} value={sevFilter} onChange={e => setSevFilter(e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="ok">OK</option>
        </select>

        <select style={ghostSelect} value={srcFilter} onChange={e => setSrcFilter(e.target.value)}>
          <option value="">All sources</option>
          {sources.map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
        </select>

        <select style={ghostSelect} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>

        <AnimatePresence>
          {hasFilters && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              onClick={clearFilters}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                ...ghostSelect, color: 'var(--text-dim)',
              }}
            >
              <X size={11} />
              Clear
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '5px 14px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        backdropFilter: 'blur(8px)',
        flexShrink: 0,
      }}>
        {cols.map(c => (
          <button
            key={c.key}
            onClick={() => toggleSort(c.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              width: c.w ?? 'auto', flex: c.w ? undefined : 1,
              background: 'none', border: 'none', cursor: 'pointer',
              color: sortKey === c.key ? 'var(--text-head)' : 'var(--text-dim)',
              fontSize: 10, fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              padding: '2px 0',
            }}
          >
            {c.label}
            <SortIcon col={c.key} />
          </button>
        ))}
        {/* Actions column spacer */}
        <div style={{ width: 100, flexShrink: 0 }} />
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 32, color: 'var(--text-dim)', textAlign: 'center' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '60px 24px', color: 'var(--text-dim)',
          }}>
            <BellOff size={32} />
            <div style={{ fontSize: 13 }}>No alerts match your filters</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <AnimatePresence initial={false}>
              {filtered.map((a, i) => {
                const isMuted = a.status === 'resolved'
                return (
                  <motion.div
                    key={a.id}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: isMuted ? 0.4 : 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15, delay: Math.min(i * 0.01, 0.1) }}
                    className="history-row"
                    onClick={() => setDetail(a)}
                    style={{
                      display: 'flex', alignItems: 'center',
                      padding: '8px 14px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-lg)',
                      cursor: 'pointer',
                      transition: 'background 0.15s, border-color 0.15s',
                      position: 'relative',
                    }}
                    whileHover={{ background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border-bright)' }}
                  >
                    {/* Severity dot + text */}
                    <div style={{ width: 100, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: SEV_COLOUR[a.severity],
                        boxShadow: `0 0 5px ${SEV_COLOUR[a.severity]}`,
                      }} />
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: SEV_COLOUR[a.severity],
                        letterSpacing: '0.05em',
                      }}>
                        {a.severity.toUpperCase()}
                      </span>
                    </div>

                    {/* Source */}
                    <div style={{ width: 120, flexShrink: 0 }}>
                      <span style={{
                        display: 'inline-block',
                        padding: '1px 7px',
                        borderRadius: 20,
                        fontSize: 10, fontWeight: 600,
                        color: SEV_COLOUR[a.severity],
                        background: SEV_BG[a.severity],
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        maxWidth: '100%',
                      }}>
                        {a.source?.name ?? '—'}
                      </span>
                    </div>

                    {/* Title */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 500, color: 'var(--text-head)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {a.title}
                      </div>
                    </div>

                    {/* Status pill */}
                    <div style={{ width: 110, flexShrink: 0 }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        padding: '2px 8px', borderRadius: 20,
                        fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                        color: STATUS_COLOUR[a.status],
                        background: STATUS_BG[a.status],
                      }}>
                        {a.status}
                      </span>
                    </div>

                    {/* When */}
                    <div style={{ width: 90, flexShrink: 0 }}>
                      <span
                        style={{ fontSize: 11, color: 'var(--text-dim)' }}
                        title={new Date(a.first_seen).toUTCString()}
                      >
                        {relativeTime(a.first_seen)}
                      </span>
                    </div>

                    {/* Count */}
                    <div style={{ width: 60, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500 }}>
                        ×{a.occurrence_count}
                      </span>
                    </div>

                    {/* Actions — visible on row hover */}
                    <div
                      className="row-actions"
                      style={{ width: 100, flexShrink: 0, display: 'flex', gap: 4, justifyContent: 'flex-end', opacity: 0, transition: 'opacity 0.15s' }}
                      onClick={e => e.stopPropagation()}
                    >
                      {a.status === 'active' && (
                        <button onClick={() => handleAck(a)} style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 4,
                          background: 'transparent',
                          border: '1px solid rgba(255,255,255,0.12)',
                          color: 'var(--text-muted)', cursor: 'pointer',
                        }}>Ack</button>
                      )}
                      {a.status !== 'resolved' && (
                        <button onClick={() => handleResolve(a)} style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 4,
                          background: 'transparent',
                          border: '1px solid rgba(34,197,94,0.25)',
                          color: 'var(--green)', cursor: 'pointer',
                        }}>Resolve</button>
                      )}
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      <AlertDetail alert={detail} onClose={() => setDetail(null)} />

      <style>{`
        .history-row:hover .row-actions { opacity: 1 !important; }
      `}</style>
    </div>
  )
}
