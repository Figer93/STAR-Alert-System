import { useState, useEffect, useMemo } from 'react'
import type { Alert, Source } from '../types'
import { getAlerts, acknowledgeAlert, resolveAlert, exportAlertsCsv } from '../lib/api'
import { getSources } from '../lib/api'
import AlertDetail from '../components/alerts/AlertDetail'

function relativeTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

const SEV_COLOUR: Record<string, string> = {
  critical: 'var(--red)', warning: 'var(--amber)', info: 'var(--blue)', ok: 'var(--green)',
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: 4, color: 'var(--text)', fontSize: 12,
  padding: '3px 8px', cursor: 'pointer', outline: 'none',
}

export default function AlertHistory() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sevFilter, setSevFilter] = useState('')
  const [srcFilter, setSrcFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [detail, setDetail] = useState<Alert | null>(null)

  useEffect(() => {
    Promise.all([getAlerts({ limit: 500 }), getSources()])
      .then(([r, s]) => { setAlerts(r.alerts); setSources(s) })
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return alerts.filter(a => {
      if (sevFilter && a.severity !== sevFilter) return false
      if (srcFilter && a.source?.slug !== srcFilter) return false
      if (statusFilter && a.status !== statusFilter) return false
      if (q && !a.title.toLowerCase().includes(q) && !a.message.toLowerCase().includes(q)) return false
      return true
    })
  }, [alerts, search, sevFilter, srcFilter, statusFilter])

  const handleAck = async (a: Alert) => {
    await acknowledgeAlert(a.id).catch(() => {})
    setAlerts(prev => prev.map(x => x.id === a.id ? { ...x, status: 'acknowledged', acknowledged_by: 'dashboard' } : x))
  }

  const handleResolve = async (a: Alert) => {
    await resolveAlert(a.id).catch(() => {})
    setAlerts(prev => prev.map(x => x.id === a.id ? { ...x, status: 'resolved' } : x))
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'hidden' }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span style={{ color: 'var(--text-head)', fontWeight: 600, fontSize: 14 }}>
          Alert History <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 12 }}>({filtered.length})</span>
        </span>
        <button
          onClick={exportAlertsCsv}
          style={{ ...selectStyle, color: 'var(--text-head)' }}
        >
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          placeholder="Search title / message…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...selectStyle, padding: '3px 10px', minWidth: 200 }}
        />
        <select style={selectStyle} value={sevFilter} onChange={e => setSevFilter(e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="ok">OK</option>
        </select>
        <select style={selectStyle} value={srcFilter} onChange={e => setSrcFilter(e.target.value)}>
          <option value="">All sources</option>
          {sources.map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
        </select>
        <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-raised)', position: 'sticky', top: 0 }}>
                {['Severity', 'Source', 'Title', 'Status', 'When', 'Count', ''].map(h => (
                  <th key={h} style={{
                    padding: '6px 10px', textAlign: 'left',
                    color: 'var(--text-dim)', fontSize: 10, fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    borderBottom: '1px solid var(--border)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((a, i) => (
                <tr
                  key={a.id}
                  onClick={() => setDetail(a)}
                  style={{
                    cursor: 'pointer',
                    background: i % 2 === 0 ? 'var(--bg-surface)' : 'transparent',
                    opacity: a.status === 'resolved' ? 0.5 : 1,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-raised)')}
                  onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'var(--bg-surface)' : 'transparent')}
                >
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: SEV_COLOUR[a.severity], fontSize: 11, fontWeight: 700 }}>
                      {a.severity.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', fontSize: 12 }}>
                    {a.source?.name ?? '—'}
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', maxWidth: 300 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-head)' }}>
                      {a.title}
                    </div>
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)' }}>
                    {a.status}
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {relativeTime(a.first_seen)}
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-dim)' }}>
                    ×{a.occurrence_count}
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1">
                      {a.status === 'active' && (
                        <button onClick={() => handleAck(a)} style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 3,
                          background: 'var(--bg-raised)', border: '1px solid var(--border)',
                          color: 'var(--text)', cursor: 'pointer',
                        }}>Ack</button>
                      )}
                      {a.status !== 'resolved' && (
                        <button onClick={() => handleResolve(a)} style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 3,
                          background: 'var(--bg-raised)', border: '1px solid var(--border)',
                          color: 'var(--green)', cursor: 'pointer',
                        }}>Resolve</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AlertDetail alert={detail} onClose={() => setDetail(null)} />
    </div>
  )
}
