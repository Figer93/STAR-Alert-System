import { useEffect, useState } from 'react'
import { Plug, AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react'

interface PortStatus {
  switch_id:      string
  switch_name:    string | null
  port_id:        string
  port_name:      string | null
  device_name:    string | null
  device_ip:      string | null
  rx_bytes_rate:  number
  tx_bytes_rate:  number
  rx_errors_1h:   number
  tx_errors_1h:   number
  status:         'healthy' | 'warning' | 'error' | 'empty' | 'uplink'
  last_error_time: string | null
}

function bps(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} Gbps`
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)} Mbps`
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)} Kbps`
  return `${n.toFixed(0)} bps`
}

function statusColour(s: PortStatus['status']): string {
  if (s === 'healthy' || s === 'uplink') return 'var(--green)'
  if (s === 'warning') return 'var(--amber)'
  if (s === 'error')   return 'var(--red)'
  return 'var(--text-dim)'
}

export default function NetworkPorts() {
  const [rows, setRows]       = useState<PortStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/network/ports')
        if (!res.ok) throw new Error('not ok')
        const d: PortStatus[] = await res.json()
        if (!cancelled) { setRows(d); setError(false) }
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

  const hasErrors = rows.some(r => r.rx_errors_1h > 0 || r.tx_errors_1h > 0)

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Plug size={16} color="var(--accent)" />
        </div>
        <div>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            Switch Ports
          </h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            Per-port throughput and error counters — refreshes every 30 s
          </p>
        </div>
        {hasErrors && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={13} color="var(--amber)" />
            <span style={{ fontSize: 12, color: 'var(--amber)', fontWeight: 600 }}>Port errors detected</span>
          </div>
        )}
      </div>

      {loading && !rows.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="card" style={{
              height: 44, borderRadius: 'var(--radius)',
              background: 'var(--bg-raised)', animation: 'pulse 1.4s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}

      {(error || (!loading && !rows.length)) && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Plug size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>
            No port data available
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            Deploy the collector stack with a UniFi controller to begin receiving port metrics.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ overflow: 'auto', flexShrink: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Switch', 'Port', 'Device', 'RX', 'TX', 'Errors', 'Status'].map(h => (
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
              {rows.map((r, i) => {
                const errors = r.rx_errors_1h + r.tx_errors_1h
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>
                      {r.switch_name ?? r.switch_id}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text)', fontWeight: 500 }}>
                      {r.port_name ?? r.port_id}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11 }}>
                      {r.device_name ?? r.device_ip ?? '—'}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--green)' }}>
                        <ArrowDown size={10} />
                        {bps(r.rx_bytes_rate)}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
                        <ArrowUp size={10} />
                        {bps(r.tx_bytes_rate)}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {errors > 0 ? (
                        <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{errors}</span>
                      ) : (
                        <span style={{ color: 'var(--text-dim)' }}>0</span>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: statusColour(r.status) }}>
                      {r.status}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
