import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'

interface Bucket {
  bucket:      string
  target_name: string
  avg_ms:      number
  max_ms:      number
  min_ms:      number
  loss_pct:    number
}

interface LatencyData {
  period:  string
  buckets: Bucket[]
}

const PERIODS = [
  { label: '1 h',  value: '1h'  },
  { label: '6 h',  value: '6h'  },
  { label: '24 h', value: '24h' },
]

function colour(ms: number): string {
  if (ms < 20)  return 'var(--green)'
  if (ms < 80)  return 'var(--amber)'
  return 'var(--red)'
}

export default function NetworkLatency() {
  const [period, setPeriod]   = useState('1h')
  const [data, setData]       = useState<LatencyData | null>(null)
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

  // Group by target
  const targets = data
    ? Array.from(new Set(data.buckets.map(b => b.target_name)))
    : []

  const latest = (target: string): Bucket | undefined =>
    data?.buckets
      .filter(b => b.target_name === target)
      .sort((a, b) => b.bucket.localeCompare(a.bucket))[0]

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

      {(error || (!loading && !data?.buckets.length)) && (
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
              const row = latest(target)
              const col = row ? colour(row.avg_ms) : 'var(--text-dim)'
              return (
                <div key={target} className="card" style={{ padding: '14px 18px', flex: '1 1 160px' }}>
                  <p style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 6px',
                  }}>
                    {target}
                  </p>
                  {row ? (
                    <>
                      <p style={{ fontSize: 22, fontWeight: 700, color: col, margin: '0 0 2px', lineHeight: 1 }}>
                        {row.avg_ms.toFixed(1)} ms
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 2px' }}>
                        min {row.min_ms.toFixed(1)} / max {row.max_ms.toFixed(1)}
                      </p>
                      {row.loss_pct > 0 && (
                        <p style={{ fontSize: 11, color: 'var(--red)', margin: 0, fontWeight: 600 }}>
                          {row.loss_pct.toFixed(1)}% loss
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

          {/* Data table */}
          <div className="card" style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Time', 'Target', 'Avg', 'Min', 'Max', 'Loss'].map(h => (
                    <th key={h} style={{
                      padding: '8px 12px', textAlign: 'left',
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                      color: 'var(--text-dim)', textTransform: 'uppercase',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data!.buckets
                  .slice()
                  .sort((a, b) => b.bucket.localeCompare(a.bucket))
                  .slice(0, 100)
                  .map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td style={{ padding: '7px 12px', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 11 }}>
                        {new Date(row.bucket).toLocaleTimeString()}
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text)', fontWeight: 500 }}>
                        {row.target_name}
                      </td>
                      <td style={{ padding: '7px 12px', color: colour(row.avg_ms), fontWeight: 600 }}>
                        {row.avg_ms.toFixed(1)} ms
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-dim)' }}>
                        {row.min_ms.toFixed(1)} ms
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-dim)' }}>
                        {row.max_ms.toFixed(1)} ms
                      </td>
                      <td style={{ padding: '7px 12px', color: row.loss_pct > 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                        {row.loss_pct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
