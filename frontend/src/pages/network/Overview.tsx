import { useEffect, useState } from 'react'
import { Globe, Activity, Clock } from 'lucide-react'

interface Overview {
  wan:            { status: string; latency_ms: number | null; packet_loss_pct: number | null }
  internal:       { status: string; active_devices: number; error_ports: number }
  collector:      { online: boolean; last_seen: string | null; sources: Record<string, boolean> }
  open_incidents: number
  bytes_last_hour: number
  health_score:   number
}

function StatusDot({ status }: { status: string }) {
  const colour =
    status === 'healthy' ? 'var(--green)' :
    status === 'degraded' ? 'var(--amber)' : 'var(--red)'
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: colour, boxShadow: `0 0 6px ${colour}`, flexShrink: 0,
    }} />
  )
}

function ScoreRing({ score }: { score: number }) {
  const colour =
    score >= 80 ? 'var(--green)' :
    score >= 50 ? 'var(--amber)' : 'var(--red)'
  return (
    <div style={{
      width: 72, height: 72, borderRadius: '50%',
      border: `3px solid ${colour}`,
      boxShadow: `0 0 14px ${colour}40`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 22, fontWeight: 700, color: colour, lineHeight: 1 }}>{score}</span>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.06em', marginTop: 1 }}>SCORE</span>
    </div>
  )
}

function fmt(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

export default function NetworkOverview() {
  const [data, setData]     = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/network/overview')
        if (!res.ok) throw new Error('not ok')
        const d = await res.json()
        if (!cancelled) { setData(d); setError(false) }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Page header */}
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
            Infrastructure health — refreshes every 30 s
          </p>
        </div>
      </div>

      {loading && !data && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="card" style={{
              flex: '1 1 180px', height: 90, borderRadius: 'var(--radius)',
              background: 'var(--bg-raised)', animation: 'pulse 1.4s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}

      {error && !data && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Globe size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>
            No network data available
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            Deploy the collector stack to begin receiving network telemetry.
          </p>
        </div>
      )}

      {data && (
        <>
          {/* Score + metrics row */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>

            {/* Health score */}
            <div className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16, flex: '0 0 auto' }}>
              <ScoreRing score={data.health_score} />
              <div>
                <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Health</p>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-head)', margin: 0 }}>
                  {data.health_score >= 80 ? 'Good' : data.health_score >= 50 ? 'Degraded' : 'Critical'}
                </p>
                {data.open_incidents > 0 && (
                  <p style={{ fontSize: 11, color: 'var(--red)', margin: '3px 0 0' }}>
                    {data.open_incidents} open incident{data.open_incidents !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            </div>

            {/* WAN */}
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 160px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <StatusDot status={data.wan.status} />
                <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>WAN</span>
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-head)', margin: '0 0 2px' }}>
                {data.wan.latency_ms != null ? `${data.wan.latency_ms.toFixed(0)} ms` : '—'}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
                {data.wan.packet_loss_pct != null ? `${data.wan.packet_loss_pct.toFixed(1)}% loss` : 'No data'}
              </p>
            </div>

            {/* Internal */}
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 160px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <StatusDot status={data.internal.status} />
                <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Internal</span>
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-head)', margin: '0 0 2px' }}>
                {data.internal.active_devices} devices
              </p>
              <p style={{ fontSize: 11, color: data.internal.error_ports > 0 ? 'var(--amber)' : 'var(--text-dim)', margin: 0 }}>
                {data.internal.error_ports > 0 ? `${data.internal.error_ports} port${data.internal.error_ports !== 1 ? 's' : ''} with errors` : 'No port errors'}
              </p>
            </div>

            {/* Traffic */}
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 160px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Activity size={11} color="var(--accent)" />
                <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Traffic</span>
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-head)', margin: '0 0 2px' }}>
                {fmt(data.bytes_last_hour)}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>last hour</p>
            </div>

          </div>

          {/* Collector status */}
          <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: data.collector.online ? 'var(--green)' : 'var(--red)',
              boxShadow: data.collector.online ? '0 0 6px var(--green)' : 'none',
            }} />
            <span style={{ fontSize: 12, color: data.collector.online ? 'var(--text)' : 'var(--red)', fontWeight: 500 }}>
              Collector {data.collector.online ? 'online' : 'offline'}
            </span>
            {data.collector.last_seen && (
              <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={10} />
                Last seen {new Date(data.collector.last_seen).toLocaleTimeString()}
              </span>
            )}
            {Object.entries(data.collector.sources).length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginLeft: data.collector.last_seen ? 0 : 'auto' }}>
                {Object.entries(data.collector.sources).map(([src, active]) => (
                  <span key={src} style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                    color: active ? 'var(--green)' : 'var(--text-dim)',
                    textTransform: 'uppercase',
                  }}>
                    {src}
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
