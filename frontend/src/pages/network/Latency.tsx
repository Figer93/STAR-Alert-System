import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'

interface LatencyResponse {
  targets: string[]
  series:  Record<string, number | string | null>[]
}

const PERIODS = [
  { label: '15 m', value: '15m' },
  { label: '1 h',  value: '1h'  },
  { label: '6 h',  value: '6h'  },
  { label: '24 h', value: '24h' },
]

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

function colour(ms: number | null | undefined): string {
  if (ms == null) return 'var(--text-dim)'
  if (ms < 20)   return 'var(--green)'
  if (ms < 80)   return 'var(--amber)'
  return 'var(--red)'
}

export default function NetworkLatency() {
  const [period, setPeriod]   = useState('1h')
  const [data, setData]       = useState<LatencyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/network/latency?period=${period}`)
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
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [period])

  const targets = data?.targets ?? []
  const series  = data?.series  ?? []

  // Latest value per target (last entry in series)
  const latest = (target: string) => {
    const key = sanitise(target)
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i][`${key}_rtt`]
      if (v != null) return v as number
    }
    return null
  }

  const latestLoss = (target: string) => {
    const key = sanitise(target)
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i][`${key}_loss`]
      if (v != null) return v as number
    }
    return null
  }

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Activity size={16} color="var(--accent)" />
        </div>
        <div>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            Latency
          </h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            ICMP round-trip times per target — refreshes every 60 s
          </p>
        </div>

        {/* Period selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border: p.value === period ? '1px solid var(--border-bright)' : '1px solid transparent',
                background: p.value === period ? 'var(--bg-raised)' : 'transparent',
                color: p.value === period ? 'var(--text-head)' : 'var(--text-dim)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="card" style={{
              flex: '1 1 180px', height: 100, borderRadius: 'var(--radius)',
              background: 'var(--bg-raised)', animation: 'pulse 1.4s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}

      {(error || (!loading && !targets.length)) && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Activity size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>
            No latency data available
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            Deploy the collector stack to begin receiving ping metrics.
          </p>
        </div>
      )}

      {targets.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
            {targets.map(target => {
              const rtt  = latest(target)
              const loss = latestLoss(target)
              const col  = colour(rtt)
              return (
                <div key={target} className="card" style={{ padding: '14px 18px', flex: '1 1 160px' }}>
                  <p style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 6px',
                  }}>
                    {target}
                  </p>
                  {rtt != null ? (
                    <>
                      <p style={{ fontSize: 22, fontWeight: 700, color: col, margin: '0 0 2px', lineHeight: 1 }}>
                        {rtt.toFixed(1)} ms
                      </p>
                      {loss != null && loss > 0 && (
                        <p style={{ fontSize: 11, color: 'var(--red)', margin: 0, fontWeight: 600 }}>
                          {loss.toFixed(1)}% loss
                        </p>
                      )}
                    </>
                  ) : (
                    <p style={{ fontSize: 18, color: 'var(--text-dim)', margin: 0 }}>—</p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Series table */}
          {series.length > 0 && (
            <div className="card" style={{ overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                      Time
                    </th>
                    {targets.map(t => (
                      <th key={t} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {series.slice().reverse().slice(0, 60).map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td style={{ padding: '7px 12px', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 11 }}>
                        {new Date(row.time as string).toLocaleTimeString()}
                      </td>
                      {targets.map(t => {
                        const key = sanitise(t)
                        const rtt  = row[`${key}_rtt`]  as number | null
                        const loss = row[`${key}_loss`] as number | null
                        return (
                          <td key={t} style={{ padding: '7px 12px' }}>
                            {rtt != null ? (
                              <span style={{ color: colour(rtt), fontWeight: 600 }}>
                                {rtt.toFixed(1)} ms
                                {loss != null && loss > 0 && (
                                  <span style={{ color: 'var(--red)', marginLeft: 4, fontSize: 10 }}>
                                    {loss.toFixed(1)}%↓
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
