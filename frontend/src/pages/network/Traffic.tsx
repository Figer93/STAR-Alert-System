import { useEffect, useState } from 'react'
import { TrendingUp } from 'lucide-react'

interface FlowRow {
  src_ip:           string | null
  src_hostname:     string | null
  dst_ip:           string | null
  dst_hostname:     string | null
  protocol_name:    string
  bytes:            number
  packets:          number
  direction:        string | null
  percent_of_total: number
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

const PERIODS = [
  { label: '15 m', value: '15m' },
  { label: '1 h',  value: '1h'  },
  { label: '6 h',  value: '6h'  },
  { label: '24 h', value: '24h' },
]

export default function NetworkTraffic() {
  const [period, setPeriod]   = useState('1h')
  const [flows, setFlows]     = useState<FlowRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/network/flows?period=${period}&limit=50`)
        if (!res.ok) throw new Error('not ok')
        const d: FlowRow[] = await res.json()
        if (!cancelled) { setFlows(d); setError(false) }
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

  const totalBytes = flows.reduce((s, f) => s + f.bytes, 0)

  // Top talkers by src_ip
  const talkerMap: Record<string, number> = {}
  for (const f of flows) {
    const ip = f.src_ip ?? 'unknown'
    talkerMap[ip] = (talkerMap[ip] ?? 0) + f.bytes
  }
  const topTalkers = Object.entries(talkerMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

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
            NetFlow top flows — refreshes every 60 s
          </p>
        </div>

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

      {loading && !flows.length && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[1, 2].map(i => (
            <div key={i} className="card" style={{
              flex: '1 1 240px', height: 200, borderRadius: 'var(--radius)',
              background: 'var(--bg-raised)', animation: 'pulse 1.4s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}

      {(error || (!loading && !flows.length)) && (
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

      {flows.length > 0 && (
        <>
          {/* Summary */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 140px' }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 4px' }}>
                Total
              </p>
              <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
                {fmt(totalBytes)}
              </p>
            </div>
            <div className="card" style={{ padding: '14px 18px', flex: '1 1 140px' }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 4px' }}>
                Flows
              </p>
              <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
                {flows.length}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: 1 }}>

            {/* Top talkers */}
            {topTalkers.length > 0 && (
              <div className="card" style={{ flex: '1 1 200px', overflow: 'auto' }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 10px', padding: '10px 12px 0' }}>
                  Top Talkers
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['IP', 'Bytes'].map(h => (
                        <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {topTalkers.map(([ip, bytes], i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text)' }}>{ip}</td>
                        <td style={{ padding: '7px 12px', color: 'var(--accent)', fontWeight: 600 }}>{fmt(bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Flow table */}
            <div className="card" style={{ flex: '2 1 360px', overflow: 'auto' }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 10px', padding: '10px 12px 0' }}>
                Top Flows
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Src', 'Dst', 'Proto', 'Bytes', '%', 'Dir'].map(h => (
                      <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flows.map((f, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                        {f.src_hostname ?? f.src_ip ?? '—'}
                      </td>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                        {f.dst_hostname ?? f.dst_ip ?? '—'}
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-dim)', textTransform: 'uppercase', fontSize: 10, fontWeight: 600 }}>
                        {f.protocol_name}
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text)', fontWeight: 600 }}>
                        {fmt(f.bytes)}
                      </td>
                      <td style={{ padding: '7px 12px', color: 'var(--text-dim)', fontSize: 11 }}>
                        {f.percent_of_total.toFixed(1)}%
                      </td>
                      <td style={{ padding: '7px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: dirColour(f.direction) }}>
                        {f.direction ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
