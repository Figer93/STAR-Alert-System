import { useEffect, useState } from 'react'
import { Search, AlertTriangle, CheckCircle, Clock, ChevronRight } from 'lucide-react'

interface Incident {
  id:               string
  kind:             string
  title:            string
  description:      string
  severity:         string
  status:           string
  affected_ip:      string | null
  affected_switch:  string | null
  evidence:         Record<string, unknown> | null
  opened_at:        string
  resolved_at:      string | null
}

interface HypothesisResult {
  ip:          string
  hypotheses:  { rule: string; severity: string; detail: string }[]
  checked_at:  string
}

function severityColour(s: string): string {
  if (s === 'critical') return 'var(--red)'
  if (s === 'warning')  return 'var(--amber)'
  return 'var(--text-dim)'
}

function reltime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function NetworkInvestigate() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading]     = useState(true)
  const [resolving, setResolving] = useState<string | null>(null)

  const [ipQuery, setIpQuery]       = useState('')
  const [hyp, setHyp]               = useState<HypothesisResult | null>(null)
  const [hypLoading, setHypLoading] = useState(false)
  const [hypError, setHypError]     = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/network/incidents')
        if (!res.ok) throw new Error('not ok')
        const d = await res.json()
        if (!cancelled) setIncidents(d)
      } catch { /* silent */ } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const resolve = async (id: string) => {
    setResolving(id)
    try {
      const res = await fetch(`/api/network/incidents/${id}/resolve`, { method: 'POST' })
      if (res.ok) {
        setIncidents(prev => prev.map(i => i.id === id ? { ...i, status: 'resolved', resolved_at: new Date().toISOString() } : i))
      }
    } finally {
      setResolving(null)
    }
  }

  const investigate = async () => {
    const ip = ipQuery.trim()
    if (!ip) return
    setHypLoading(true)
    setHypError('')
    setHyp(null)
    try {
      const res = await fetch(`/api/network/investigate/${encodeURIComponent(ip)}`)
      if (!res.ok) throw new Error('not ok')
      const d = await res.json()
      setHyp(d)
    } catch {
      setHypError('Could not retrieve investigation data. Ensure the collector is running and the IP is active.')
    } finally {
      setHypLoading(false)
    }
  }

  const open   = incidents.filter(i => i.status === 'open')
  const closed = incidents.filter(i => i.status === 'resolved')

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Search size={16} color="var(--accent)" />
        </div>
        <div>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            Investigate
          </h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            Active incidents and per-device hypothesis engine
          </p>
        </div>
      </div>

      {/* IP investigate box */}
      <div className="card" style={{ padding: '12px 14px' }}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 8px' }}>
          Device Investigation
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={ipQuery}
            onChange={e => setIpQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && investigate()}
            placeholder="Enter IP address (e.g. 192.168.1.10)"
            style={{
              flex: 1, padding: '6px 10px', fontSize: 12,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text)',
              outline: 'none', fontFamily: 'monospace',
            }}
          />
          <button
            onClick={investigate}
            disabled={hypLoading || !ipQuery.trim()}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              background: 'var(--accent-dim)', border: '1px solid var(--accent)',
              color: 'var(--accent)', opacity: (hypLoading || !ipQuery.trim()) ? 0.5 : 1,
            }}
          >
            {hypLoading ? 'Checking…' : 'Investigate'}
          </button>
        </div>

        {hypError && (
          <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 8, marginBottom: 0 }}>{hypError}</p>
        )}

        {hyp && (
          <div style={{ marginTop: 10 }}>
            {hyp.hypotheses.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={14} color="var(--green)" />
                <span style={{ fontSize: 12, color: 'var(--green)' }}>No anomalies detected for {hyp.ip}</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {hyp.hypotheses.map((h, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-raised)', border: `1px solid ${severityColour(h.severity)}30`,
                  }}>
                    <AlertTriangle size={12} color={severityColour(h.severity)} style={{ flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <p style={{ fontSize: 11, fontWeight: 700, color: severityColour(h.severity), margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {h.rule}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>{h.detail}</p>
                    </div>
                  </div>
                ))}
                <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: 0 }}>
                  Checked at {new Date(hyp.checked_at).toLocaleTimeString()}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Open incidents */}
      <div style={{ flexShrink: 0 }}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 6px' }}>
          Open Incidents {open.length > 0 && <span style={{ color: 'var(--red)' }}>({open.length})</span>}
        </p>

        {loading && !incidents.length && (
          <div className="card" style={{
            height: 60, borderRadius: 'var(--radius)',
            background: 'var(--bg-raised)', animation: 'pulse 1.4s ease-in-out infinite',
          }} />
        )}

        {!loading && open.length === 0 && (
          <div className="card" style={{ padding: '16px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckCircle size={14} color="var(--green)" />
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>No open incidents — all clear.</span>
          </div>
        )}

        {open.map(inc => (
          <div key={inc.id} className="card" style={{
            padding: '10px 14px', marginBottom: 6,
            borderLeft: `3px solid ${severityColour(inc.severity)}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', margin: '0 0 2px' }}>
                  {inc.title}
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 4px' }}>
                  {inc.description}
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {inc.affected_ip && (
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace' }}>{inc.affected_ip}</span>
                  )}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-dim)' }}>
                    <Clock size={9} />
                    {reltime(inc.opened_at)}
                  </span>
                </div>
              </div>
              <button
                onClick={() => resolve(inc.id)}
                disabled={resolving === inc.id}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 600, flexShrink: 0,
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  background: 'transparent', border: '1px solid var(--border-bright)',
                  color: 'var(--text-dim)', opacity: resolving === inc.id ? 0.5 : 1,
                }}
              >
                {resolving === inc.id ? 'Resolving…' : 'Resolve'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Recent resolved */}
      {closed.length > 0 && (
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 6px' }}>
            Recently Resolved
          </p>
          {closed.slice(0, 10).map(inc => (
            <div key={inc.id} className="card" style={{
              padding: '8px 14px', marginBottom: 4,
              opacity: 0.6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={12} color="var(--green)" />
                <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>{inc.title}</span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={9} />
                  {inc.resolved_at ? reltime(inc.resolved_at) : '—'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
