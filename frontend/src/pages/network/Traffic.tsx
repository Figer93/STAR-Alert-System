import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TrendingUp, ChevronDown, ChevronUp, Download, ExternalLink } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis,
  PieChart, Pie, Cell,
  Tooltip as ReTooltip, ResponsiveContainer,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface Talker {
  ip:       string
  label:    string
  sent:     number
  received: number
  total:    number
}

interface ProtoBucket {
  name:    string
  bytes:   number
  pct:     number
  devices: number
  color:   string
}

interface Anomaly {
  type:     'high_traffic' | 'large_transfer' | 'unusual_protocol'
  icon:     string
  desc:     string
  bytes:    number
  ip:       string | null
  hostname: string | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PERIODS = [
  { label: '15 m', value: '15m' },
  { label: '1 h',  value: '1h'  },
  { label: '6 h',  value: '6h'  },
  { label: '24 h', value: '24h' },
] as const
type Period = typeof PERIODS[number]['value']

const PROTO_CATS: Record<string, string> = {
  'HTTPS':       'HTTPS',
  'HTTPS-Alt':   'HTTPS',
  'HTTP':        'HTTP',
  'HTTP-Alt':    'HTTP',
  'DNS':         'DNS',
  'SMB':         'SMB',
  'RDP':         'RDP',
  'STUN':        'Video/Collab',
  'Zoom':        'Video/Collab',
  'Google-Meet': 'Video/Collab',
  'ICMP':        'ICMP',
  'SSH':         'SSH',
  'FTP':         'FTP',
  'SMTP':        'Email',
  'SMTP-TLS':    'Email',
  'MSSQL':       'Database',
  'MySQL':       'Database',
  'PostgreSQL':  'Database',
}

const PROTO_COLORS: Record<string, string> = {
  'HTTPS':       '#3b82f6',
  'HTTP':        '#60a5fa',
  'DNS':         '#22c55e',
  'SMB':         '#f59e0b',
  'RDP':         '#ef4444',
  'Video/Collab':'#a855f7',
  'ICMP':        '#06b6d4',
  'SSH':         '#84cc16',
  'Email':       '#ec4899',
  'FTP':         '#f97316',
  'Database':    '#eab308',
  'Other':       '#6b7280',
}

const FLAGGED_PROTOS = new Set(['RDP', 'FTP', 'MSSQL', 'MySQL', 'PostgreSQL'])

type TableSortCol = 'src' | 'dst' | 'proto' | 'bytes' | 'packets' | 'dir'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`
  return `${n} B`
}

function trunc(s: string, n = 18): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function categorise(proto: string): string {
  return PROTO_CATS[proto] ?? 'Other'
}

function srcLabel(f: FlowRow): string {
  return f.src_hostname ?? f.src_ip ?? '—'
}

function dstLabel(f: FlowRow): string {
  return f.dst_hostname ?? f.dst_ip ?? '—'
}

// ── Data derivation ───────────────────────────────────────────────────────────

function computeTalkers(flows: FlowRow[]): Talker[] {
  const map = new Map<string, Talker>()

  for (const f of flows) {
    if (f.src_ip) {
      const t = map.get(f.src_ip) ?? { ip: f.src_ip, label: f.src_hostname ?? f.src_ip, sent: 0, received: 0, total: 0 }
      t.sent  += f.bytes
      t.total += f.bytes
      map.set(f.src_ip, t)
    }
    if (f.dst_ip) {
      const t = map.get(f.dst_ip) ?? { ip: f.dst_ip, label: f.dst_hostname ?? f.dst_ip, sent: 0, received: 0, total: 0 }
      t.received += f.bytes
      t.total    += f.bytes
      map.set(f.dst_ip, t)
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map(t => ({ ...t, label: trunc(t.label) }))
}

function computeProtos(flows: FlowRow[]): ProtoBucket[] {
  const buckets = new Map<string, { bytes: number; ips: Set<string> }>()

  for (const f of flows) {
    const cat = categorise(f.protocol_name)
    const b   = buckets.get(cat) ?? { bytes: 0, ips: new Set() }
    b.bytes += f.bytes
    if (f.src_ip) b.ips.add(f.src_ip)
    buckets.set(cat, b)
  }

  const total = Array.from(buckets.values()).reduce((s, b) => s + b.bytes, 0) || 1

  return Array.from(buckets.entries())
    .map(([name, b]) => ({
      name,
      bytes:   b.bytes,
      pct:     (b.bytes / total) * 100,
      devices: b.ips.size,
      color:   PROTO_COLORS[name] ?? '#6b7280',
    }))
    .sort((a, b) => b.bytes - a.bytes)
}

function computeAnomalies(flows: FlowRow[]): Anomaly[] {
  const out: Anomaly[] = []

  // ── High traffic device ──────────────────────────────────────────────────
  const devBytes = new Map<string, { ip: string; label: string; bytes: number }>()
  for (const f of flows) {
    if (!f.src_ip) continue
    const d = devBytes.get(f.src_ip) ?? { ip: f.src_ip, label: f.src_hostname ?? f.src_ip, bytes: 0 }
    d.bytes += f.bytes
    devBytes.set(f.src_ip, d)
  }

  const allBytes = Array.from(devBytes.values()).map(d => d.bytes)
  if (allBytes.length > 2) {
    const mean = allBytes.reduce((s, v) => s + v, 0) / allBytes.length
    for (const d of devBytes.values()) {
      if (d.bytes > mean * 3 && d.bytes > 10_000_000) {
        out.push({
          type: 'high_traffic',
          icon: '📈',
          desc: `${d.label} is using ${(d.bytes / mean).toFixed(1)}x more traffic than average`,
          bytes: d.bytes,
          ip: d.ip,
          hostname: d.label !== d.ip ? d.label : null,
        })
      }
    }
  }

  // ── Large single transfer ────────────────────────────────────────────────
  const seenLarge = new Set<string>()
  for (const f of flows) {
    if (f.bytes > 50_000_000) {
      const key = `${f.src_ip}→${f.dst_ip}`
      if (seenLarge.has(key)) continue
      seenLarge.add(key)
      out.push({
        type: 'large_transfer',
        icon: '📦',
        desc: `${srcLabel(f)} transferred ${fmt(f.bytes)} to ${dstLabel(f)}`,
        bytes: f.bytes,
        ip:    f.src_ip,
        hostname: f.src_hostname,
      })
    }
  }

  // ── Unusual / security-relevant protocols ────────────────────────────────
  const flaggedSeen = new Set<string>()
  for (const f of flows) {
    if (FLAGGED_PROTOS.has(f.protocol_name) && !flaggedSeen.has(f.protocol_name)) {
      flaggedSeen.add(f.protocol_name)
      out.push({
        type: 'unusual_protocol',
        icon: '🔍',
        desc: `${srcLabel(f)} using ${f.protocol_name} — verify this connection is expected`,
        bytes: f.bytes,
        ip:    f.src_ip,
        hostname: f.src_hostname,
      })
    }
  }

  return out
}

// ── Bar chart tooltip ─────────────────────────────────────────────────────────

function TalkerTooltip({
  active, payload, label,
}: {
  active?: boolean
  payload?: Array<{ value: number; name: string; color: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  const sent     = payload.find(p => p.name === 'sent')?.value ?? 0
  const received = payload.find(p => p.name === 'received')?.value ?? 0
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border-bright)',
      borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 11,
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    }}>
      <p style={{ color: 'var(--text-head)', fontWeight: 700, margin: '0 0 6px' }}>{label}</p>
      <p style={{ color: '#3b82f6', margin: '0 0 3px' }}>↑ Sent: {fmt(sent)}</p>
      <p style={{ color: '#22c55e', margin: '0 0 3px' }}>↓ Received: {fmt(received)}</p>
      <p style={{ color: 'var(--text-dim)', margin: 0, borderTop: '1px solid var(--border)', paddingTop: 4, marginTop: 4 }}>
        Total: {fmt(sent + received)}
      </p>
    </div>
  )
}

// ── Donut tooltip ─────────────────────────────────────────────────────────────

function DonutTooltip({
  active, payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ProtoBucket }>
}) {
  if (!active || !payload?.[0]) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border-bright)',
      borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 11,
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    }}>
      <p style={{ color: 'var(--text-head)', fontWeight: 700, margin: '0 0 4px' }}>{d.name}</p>
      <p style={{ color: 'var(--text-dim)', margin: '0 0 2px' }}>{fmt(d.bytes)} — {d.pct.toFixed(1)}%</p>
      <p style={{ color: 'var(--text-dim)', margin: 0 }}>{d.devices} device{d.devices !== 1 ? 's' : ''}</p>
    </div>
  )
}

// ── Anomaly card ──────────────────────────────────────────────────────────────

function AnomalyCard({ a }: { a: Anomaly }) {
  const navigate = useNavigate()
  const borderColor = a.type === 'high_traffic' ? '#f59e0b' : a.type === 'large_transfer' ? '#3b82f6' : '#ef4444'

  return (
    <div style={{
      background:   'var(--bg-surface)',
      border:       `1px solid ${borderColor}44`,
      borderLeft:   `3px solid ${borderColor}`,
      borderRadius: 'var(--radius)',
      padding:      '12px 14px',
      display:      'flex',
      alignItems:   'center',
      gap:          12,
    }}>
      <span style={{ fontSize: 20, flexShrink: 0 }}>{a.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, color: 'var(--text)', margin: '0 0 3px', fontWeight: 500 }}>{a.desc}</p>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>{fmt(a.bytes)}</p>
      </div>
      {a.ip && (
        <button
          onClick={() => navigate(`/network/investigate?ip=${a.ip}`)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', fontSize: 11, fontWeight: 600,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            border: '1px solid var(--border-bright)',
            background: 'var(--accent-dim)', color: 'var(--accent)',
            flexShrink: 0,
          }}
        >
          <ExternalLink size={11} />
          Investigate
        </button>
      )}
    </div>
  )
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCsv(flows: FlowRow[]) {
  const header = ['Source', 'Destination', 'Protocol', 'Bytes', 'Packets', 'Direction']
  const rows   = flows.map(f => [
    srcLabel(f), dstLabel(f),
    f.protocol_name,
    f.bytes, f.packets,
    f.direction ?? '—',
  ])
  const csv  = [header, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `flows_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Section heading ───────────────────────────────────────────────────────────

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize:      10,
      fontWeight:    700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color:         'var(--text-dim)',
      margin:        '0 0 12px',
    }}>
      {children}
    </p>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function NetworkTraffic() {
  const navigate = useNavigate()

  const [period, setPeriod]   = useState<Period>('1h')
  const [ipInput, setIpInput] = useState('')
  const [ip, setIp]           = useState('')
  const [flows, setFlows]     = useState<FlowRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const [tablePage, setTablePage] = useState(1)
  const [sortCol, setSortCol]     = useState<TableSortCol>('bytes')
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('desc')

  // Debounce IP filter
  useEffect(() => {
    const t = setTimeout(() => setIp(ipInput.trim()), 500)
    return () => clearTimeout(t)
  }, [ipInput])

  // Fetch
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ period, limit: '200' })
        if (ip) params.set('ip', ip)
        const res = await fetch(`/api/network/flows?${params}`)
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
  }, [period, ip])

  // ── Derived data ──────────────────────────────────────────────────────────

  const talkers   = useMemo(() => computeTalkers(flows),  [flows])
  const protocols = useMemo(() => computeProtos(flows),   [flows])
  const anomalies = useMemo(() => computeAnomalies(flows), [flows])
  const totalBytes = useMemo(() => flows.reduce((s, f) => s + f.bytes, 0), [flows])

  const tableSorted = useMemo(() => {
    return [...flows].sort((a, b) => {
      let av: number | string = 0
      let bv: number | string = 0
      if (sortCol === 'src')     { av = srcLabel(a); bv = srcLabel(b) }
      if (sortCol === 'dst')     { av = dstLabel(a); bv = dstLabel(b) }
      if (sortCol === 'proto')   { av = a.protocol_name; bv = b.protocol_name }
      if (sortCol === 'bytes')   { av = a.bytes;   bv = b.bytes }
      if (sortCol === 'packets') { av = a.packets; bv = b.packets }
      if (sortCol === 'dir')     { av = a.direction ?? ''; bv = b.direction ?? '' }
      if (av < bv) return sortDir === 'asc' ? -1 :  1
      if (av > bv) return sortDir === 'asc' ?  1 : -1
      return 0
    })
  }, [flows, sortCol, sortDir])

  const tablePages  = Math.ceil(tableSorted.length / PAGE_SIZE)
  const tableRows   = tableSorted.slice((tablePage - 1) * PAGE_SIZE, tablePage * PAGE_SIZE)

  function toggleSort(col: TableSortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
    setTablePage(1)
  }

  function SortIcon({ col }: { col: TableSortCol }) {
    if (sortCol !== col) return <ChevronUp size={10} style={{ opacity: 0.25 }} />
    return sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <TrendingUp size={16} color="var(--accent)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>Traffic</h1>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            NetFlow top flows — refreshes every 60 s
          </p>
        </div>

        {/* Period buttons */}
        <div style={{ display: 'flex', gap: 3 }}>
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border:      period === p.value ? '1px solid var(--border-bright)' : '1px solid transparent',
                background:  period === p.value ? 'var(--bg-raised)' : 'transparent',
                color:       period === p.value ? 'var(--text-head)' : 'var(--text-dim)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* IP filter */}
        <input
          value={ipInput}
          onChange={e => setIpInput(e.target.value)}
          placeholder="Filter by IP…"
          style={{
            background:   'var(--bg-raised)',
            border:       `1px solid ${ip ? 'var(--border-bright)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)',
            color:        'var(--text)',
            fontSize:     12,
            padding:      '5px 10px',
            width:        140,
            outline:      'none',
          }}
        />
      </div>

      {/* ── Loading ─────────────────────────────────────────────────────────── */}
      {loading && !flows.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[200, 160, 280].map((h, i) => (
            <div key={i} className="card" style={{ height: h, animation: 'pulse 1.4s ease-in-out infinite' }} />
          ))}
        </div>
      )}

      {/* ── Empty / error ────────────────────────────────────────────────────── */}
      {(error || (!loading && !flows.length)) && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <TrendingUp size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>
            No traffic data available
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            Enable NetFlow/IPFIX export on your router and deploy the collector stack.
          </p>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      {!loading && flows.length > 0 && (
        <>
          {/* Summary strip */}
          <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            {[
              { label: 'Total', value: fmt(totalBytes) },
              { label: 'Flows', value: flows.length.toString() },
              { label: 'Devices', value: new Set(flows.flatMap(f => [f.src_ip, f.dst_ip]).filter(Boolean)).size.toString() },
              { label: 'Protocols', value: protocols.length.toString() },
            ].map(({ label, value }) => (
              <div key={label} className="card" style={{ padding: '10px 16px', flex: '1 1 80px' }}>
                <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 3px' }}>
                  {label}
                </p>
                <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>{value}</p>
              </div>
            ))}
          </div>

          {/* ── Section 1: Top Talkers ─────────────────────────────────────── */}
          <div className="card" style={{ padding: '14px 16px', flexShrink: 0 }}>
            <SectionHead>Top Talkers</SectionHead>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-dim)' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#3b82f6', display: 'inline-block' }} />
                Sent
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-dim)' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#22c55e', display: 'inline-block' }} />
                Received
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 4 }}>
                — click to investigate
              </span>
            </div>

            <ResponsiveContainer width="100%" height={talkers.length * 36 + 24}>
              <BarChart
                layout="vertical"
                data={talkers}
                margin={{ top: 0, right: 60, bottom: 0, left: 0 }}
                style={{ cursor: 'pointer' }}
              >
                <XAxis
                  type="number"
                  tickFormatter={v => fmt(v as number)}
                  tick={{ fontSize: 9, fill: 'var(--text-dim)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={120}
                  tick={{ fontSize: 11, fill: 'var(--text)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReTooltip content={<TalkerTooltip />} />
                <Bar
                  dataKey="sent"
                  stackId="total"
                  fill="#3b82f6"
                  radius={[0, 0, 0, 0]}
                  onClick={(data: unknown) => {
                    const ip = (data as Talker).ip
                    if (ip) navigate(`/network/investigate?ip=${ip}`)
                  }}
                />
                <Bar
                  dataKey="received"
                  stackId="total"
                  fill="#22c55e"
                  radius={[0, 3, 3, 0]}
                  label={{ position: 'right', formatter: (v: unknown) => fmt(Number(v)), fontSize: 10, fill: 'var(--text-dim)' }}
                  onClick={(data: unknown) => {
                    const ip = (data as Talker).ip
                    if (ip) navigate(`/network/investigate?ip=${ip}`)
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── Section 2: Protocol Breakdown ─────────────────────────────── */}
          <div style={{ display: 'flex', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>

            {/* Donut chart */}
            <div className="card" style={{ padding: '14px 16px', flex: '0 0 260px' }}>
              <SectionHead>Protocol Breakdown</SectionHead>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <PieChart width={220} height={200}>
                  <Pie
                    data={protocols}
                    dataKey="bytes"
                    nameKey="name"
                    cx={110}
                    cy={100}
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={2}
                    label={({ name, percent }: { name?: string; percent?: number }) =>
                      (percent ?? 0) > 0.05 ? `${name} ${((percent ?? 0) * 100).toFixed(0)}%` : ''
                    }
                    labelLine={false}
                  >
                    {protocols.map((p, i) => (
                      <Cell key={i} fill={p.color} />
                    ))}
                  </Pie>
                  <ReTooltip content={<DonutTooltip />} />
                </PieChart>
              </div>
            </div>

            {/* Protocol table */}
            <div className="card" style={{ padding: '14px 0', flex: '1 1 280px', overflow: 'auto' }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 12px', paddingLeft: 16 }}>
                Protocol Table
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Protocol', 'Bytes', '% Total', 'Devices'].map(h => (
                      <th key={h} style={{ padding: '6px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {protocols.map((p, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td style={{ padding: '7px 16px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{p.name}</span>
                        </span>
                      </td>
                      <td style={{ padding: '7px 16px', color: 'var(--text-dim)' }}>{fmt(p.bytes)}</td>
                      <td style={{ padding: '7px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 60, height: 5, borderRadius: 3, background: 'var(--bg-raised)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(p.pct, 100)}%`, height: '100%', background: p.color, borderRadius: 3 }} />
                          </div>
                          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{p.pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '7px 16px', color: 'var(--text-dim)' }}>{p.devices}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Section 3: Anomalies ───────────────────────────────────────── */}
          <div className="card" style={{ padding: '14px 16px', flexShrink: 0 }}>
            <SectionHead>Anomalies</SectionHead>
            {anomalies.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {anomalies.map((a, i) => <AnomalyCard key={i} a={a} />)}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 'var(--radius)', border: '1px solid #22c55e22' }}>
                <span style={{ fontSize: 18 }}>✅</span>
                <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
                  No unusual traffic patterns detected
                </span>
              </div>
            )}
          </div>

          {/* ── Section 4: Flow Table (collapsible) ───────────────────────── */}
          <div className="card" style={{ padding: 0, flexShrink: 0 }}>
            {/* Collapse header */}
            <button
              onClick={() => setTableOpen(o => !o)}
              style={{
                width:      '100%',
                display:    'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding:    '12px 16px',
                background: 'none',
                border:     'none',
                cursor:     'pointer',
                borderBottom: tableOpen ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                Flow Table — {flows.length} flows
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {tableOpen && (
                  <button
                    onClick={e => { e.stopPropagation(); exportCsv(flows) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '4px 10px', fontSize: 11, fontWeight: 600,
                      borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                      border: '1px solid var(--border)',
                      background: 'var(--bg-raised)', color: 'var(--text-dim)',
                    }}
                  >
                    <Download size={11} />
                    Export CSV
                  </button>
                )}
                {tableOpen ? <ChevronUp size={14} color="var(--text-dim)" /> : <ChevronDown size={14} color="var(--text-dim)" />}
              </div>
            </button>

            {tableOpen && (
              <>
                <div style={{ overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {(
                          [
                            ['src',     'Source'],
                            ['dst',     'Destination'],
                            ['proto',   'Protocol'],
                            ['bytes',   'Bytes'],
                            ['packets', 'Packets'],
                            ['dir',     'Direction'],
                          ] as [TableSortCol, string][]
                        ).map(([col, label]) => (
                          <th
                            key={col}
                            onClick={() => toggleSort(col)}
                            style={{
                              padding: '8px 12px', textAlign: 'left', cursor: 'pointer',
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                              color: sortCol === col ? 'var(--text-head)' : 'var(--text-dim)',
                              textTransform: 'uppercase', userSelect: 'none',
                            }}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {label}
                              <SortIcon col={col} />
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((f, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text)' }}>
                            {srcLabel(f)}
                          </td>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                            {dstLabel(f)}
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--text-dim)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            {f.protocol_name}
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--text)', fontWeight: 600 }}>
                            {fmt(f.bytes)}
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--text-dim)', fontSize: 11 }}>
                            {f.packets.toLocaleString()}
                          </td>
                          <td style={{ padding: '7px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            {f.direction === 'inbound'
                              ? <span style={{ color: '#22c55e' }}>↓ in</span>
                              : f.direction === 'outbound'
                              ? <span style={{ color: '#3b82f6' }}>↑ out</span>
                              : <span style={{ color: 'var(--text-dim)' }}>—</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {tablePages > 1 && (
                  <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px solid var(--border-dim)', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: 1 }}>
                      {tableSorted.length} flows — page {tablePage} of {tablePages}
                    </span>
                    {Array.from({ length: tablePages }, (_, i) => i + 1).map(pg => (
                      <button
                        key={pg}
                        onClick={() => setTablePage(pg)}
                        style={{
                          width: 28, height: 28, borderRadius: 'var(--radius-sm)',
                          border:      pg === tablePage ? '1px solid var(--border-bright)' : '1px solid transparent',
                          background:  pg === tablePage ? 'var(--bg-raised)' : 'transparent',
                          color:       pg === tablePage ? 'var(--text-head)' : 'var(--text-dim)',
                          fontSize: 12, cursor: 'pointer',
                          fontWeight: pg === tablePage ? 700 : 400,
                        }}
                      >
                        {pg}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
