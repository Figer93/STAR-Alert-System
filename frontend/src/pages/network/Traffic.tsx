import { useEffect, useState } from 'react'
import { TrendingUp } from 'lucide-react'

interface FlowRow {
  src_ip:       string | null
  dst_ip:       string | null
  src_port:     number | null
  dst_port:     number | null
  protocol:     string | null
  bytes:        number
  packets:      number
  direction:    string | null
  time:         string
}

interface TrafficData {
  top_talkers:  { ip: string; bytes: number }[]
  top_flows:    FlowRow[]
  total_bytes:  number
  total_flows:  number
}

function fmt(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`
  return `${bytes} B`
}

function dirColour(dir: string | null): string {
  if (dir === 'inbound')  return 'var(--green)'
  if (dir === 'outbound') return 'var(--accent)'
  return 'var(--text-dim)'
}

export default function NetworkTraffic() {
  const [data, setData]       = useState<TrafficData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/network/flows')
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
          <TrendingUp size={16} color="var(--accent)" />
        </div>
        <div>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            Traffic
          </h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            NetFlow data — top talkers and recent flows
          </p>
        </div>
      </div>

      {loading && !data && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[1, 2].map(i => (
            <div key={i} className="card" style={{
              flex: '1 1 240px', height: 200, borderRadius: 'var(--radius)',
              background: 'var(--bg-raised)', animation: 'pulse 1.4s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}

      {(error || (!loading && !data)) && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <TrendingUp size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>
            No traffic data available
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            Enable NetFlow/IPFIX export on your pfSense router and deploy the collector stack.
          </p>
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 140px' }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 4px' }}>
                Total (1 h)
              </p>
              <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
                {fmt(data.total_bytes)}
              </p>
            </div>
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 140px' }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 4px' }}>
                Flows (1 h)
              </p>
              <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
                {data.total_flows.toLocaleString()}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: 1 }}>

            {/* Top talkers */}
            {data.top_talkers.length > 0 && (
              <div className="card" style={{ flex: '1 1 200px', overflow: 'auto' }}>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--text-dim)',
                  margin: '0 0 10px', padding: '10px 12px 0',
                }}>
                  Top Talkers
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['IP', 'Bytes'].map(h => (
                        <th key={h} style={{
                          padding: '6px 12px', textAlign: 'left',
                          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                          color: 'var(--text-dim)', textTransform: 'uppercase',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_talkers.map((t, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text)' }}>
                          {t.ip}
                        </td>
                        <td style={{ padding: '7px 12px', color: 'var(--accent)', fontWeight: 600 }}>
                          {fmt(t.bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recent flows */}
            {data.top_flows.length > 0 && (
              <div className="card" style={{ flex: '2 1 360px', overflow: 'auto' }}>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--text-dim)',
                  margin: '0 0 10px', padding: '10px 12px 0',
                }}>
                  Recent Flows
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Src', 'Dst', 'Proto', 'Bytes', 'Dir'].map(h => (
                        <th key={h} style={{
                          padding: '6px 12px', textAlign: 'left',
                          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                          color: 'var(--text-dim)', textTransform: 'uppercase',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_flows.map((f, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                          {f.src_ip ?? '—'}{f.src_port != null ? `:${f.src_port}` : ''}
                        </td>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                          {f.dst_ip ?? '—'}{f.dst_port != null ? `:${f.dst_port}` : ''}
                        </td>
                        <td style={{ padding: '7px 12px', color: 'var(--text-dim)', textTransform: 'uppercase', fontSize: 10, fontWeight: 600 }}>
                          {f.protocol ?? '—'}
                        </td>
                        <td style={{ padding: '7px 12px', color: 'var(--text)', fontWeight: 600 }}>
                          {fmt(f.bytes)}
                        </td>
                        <td style={{ padding: '7px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: dirColour(f.direction) }}>
                          {f.direction ?? '—'}
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
