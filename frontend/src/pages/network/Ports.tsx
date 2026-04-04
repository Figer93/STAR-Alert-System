import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plug, Search, X, ExternalLink,
  ArrowDown, ArrowUp, ChevronUp, ChevronDown,
  Server, Monitor, Wifi as WifiIcon, Router, HardDrive, Download,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis,
  Tooltip as ReTooltip, ResponsiveContainer,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortStatus {
  switch_id:       string
  switch_name:     string | null
  port_id:         string
  port_name:       string | null
  device_name:     string | null
  device_ip:       string | null
  rx_bytes_rate:   number
  tx_bytes_rate:   number
  rx_errors_1h:    number
  tx_errors_1h:    number
  status:          'healthy' | 'warning' | 'error' | 'empty' | 'uplink'
  last_error_time: string | null
}

interface DeviceDetail {
  ip:              string
  mac:             string | null
  hostname:        string | null
  device_type:     string | null
  is_online:       boolean
  port_errors_24h: Array<{ time: string; rx_errors: number; tx_errors: number }>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<PortStatus['status'], string> = {
  healthy: '#22c55e',
  warning: '#eab308',
  error:   '#ef4444',
  empty:   '#374151',
  uplink:  '#3b82f6',
}

const PORTS_PER_ROW    = 24
const HIGH_TRAFFIC_BPS = 10_000_000 // 10 Mbps
const PAGE_SIZE        = 25

const FILTERS = ['all', 'errors', 'high_traffic', 'empty'] as const
type Filter   = typeof FILTERS[number]

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All', errors: 'Errors', high_traffic: 'High Traffic', empty: 'Empty',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bps(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} Gbps`
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)} Mbps`
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)} Kbps`
  return `${n.toFixed(0)} bps`
}

function portNum(p: PortStatus): number {
  const m = (p.port_name ?? p.port_id).match(/\d+/)
  return m ? parseInt(m[0], 10) : 0
}

type SortCol = 'port' | 'device' | 'ip' | 'rx' | 'tx' | 'errors' | 'status' | 'last_error'

function DeviceIcon({ type }: { type: string | null | undefined }) {
  const t = (type ?? '').toLowerCase()
  if (t === 'server')                     return <Server size={14} />
  if (t === 'workstation' || t === 'desktop') return <Monitor size={14} />
  if (t === 'wireless' || t === 'ap')     return <WifiIcon size={14} />
  if (t === 'router' || t === 'gateway')  return <Router size={14} />
  if (t === 'nas' || t === 'storage')     return <HardDrive size={14} />
  return <Plug size={14} />
}

// ── Port Tooltip ──────────────────────────────────────────────────────────────

interface TooltipPos { port: PortStatus; x: number; y: number }

function PortTooltip({ port: p, x, y }: TooltipPos) {
  return (
    <div style={{
      position:     'fixed',
      left:         x + 14,
      top:          y - 14,
      zIndex:       9999,
      background:   'var(--bg-surface)',
      border:       '1px solid var(--border-bright)',
      borderRadius: 'var(--radius)',
      padding:      '8px 12px',
      fontSize:     12,
      pointerEvents:'none',
      minWidth:     180,
      boxShadow:    '0 8px 24px rgba(0,0,0,0.55)',
    }}>
      <p style={{ fontWeight: 700, color: 'var(--text-head)', margin: '0 0 4px' }}>
        {p.port_name ?? p.port_id}
      </p>
      {p.device_name && (
        <p style={{ color: 'var(--text)', margin: '0 0 2px' }}>{p.device_name}</p>
      )}
      {p.device_ip && (
        <p style={{ color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 11, margin: '0 0 6px' }}>
          {p.device_ip}
        </p>
      )}
      <div style={{ display: 'flex', gap: 14 }}>
        <span style={{ color: '#22c55e', fontSize: 11 }}>↓ {bps(p.rx_bytes_rate)}</span>
        <span style={{ color: '#3b82f6', fontSize: 11 }}>↑ {bps(p.tx_bytes_rate)}</span>
      </div>
      {(p.rx_errors_1h > 0 || p.tx_errors_1h > 0) && (
        <p style={{ color: '#ef4444', margin: '5px 0 0', fontSize: 11, fontWeight: 700 }}>
          {p.rx_errors_1h + p.tx_errors_1h} errors (1 h)
        </p>
      )}
    </div>
  )
}

// ── Switch Diagram ────────────────────────────────────────────────────────────

function SwitchDiagram({
  ports, selected, highlighted, onSelect,
}: {
  ports:       PortStatus[]
  selected:    string | null
  highlighted: string | null
  onSelect:    (p: PortStatus) => void
}) {
  const [tip, setTip] = useState<TooltipPos | null>(null)

  // Build slot → port map; slots are 1-based port numbers
  const slotMap = new Map<number, PortStatus>()
  let maxSlot = PORTS_PER_ROW
  for (const p of ports) {
    const n = portNum(p)
    if (n > 0) {
      slotMap.set(n, p)
      if (n > maxSlot) maxSlot = Math.ceil(n / PORTS_PER_ROW) * PORTS_PER_ROW
    }
  }
  // Un-numbered ports appended beyond grid
  let overflow = maxSlot + 1
  for (const p of ports) {
    if (portNum(p) === 0) slotMap.set(overflow++, p)
  }

  const total = Math.max(maxSlot, overflow - 1)
  const slots = Array.from({ length: total }, (_, i) => i + 1)

  return (
    <div style={{
      background:   'var(--bg-surface)',
      border:       '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding:      '16px 20px',
    }}>
      {/* Chassis */}
      <div style={{
        background:   'var(--bg-raised)',
        border:       '1px solid var(--border-bright)',
        borderRadius: 8,
        padding:      '14px 16px',
      }}>
        <div style={{
          display:             'grid',
          gridTemplateColumns: `repeat(${PORTS_PER_ROW}, 1fr)`,
          gap:                 4,
        }}>
          {slots.map(slot => {
            const p       = slotMap.get(slot)
            const status  = p?.status ?? 'empty'
            const color   = STATUS_COLORS[status]
            const active  = p?.port_id === selected || p?.port_id === highlighted

            return (
              <div
                key={slot}
                onClick={() => p && onSelect(p)}
                onMouseEnter={e => p && setTip({ port: p, x: e.clientX, y: e.clientY })}
                onMouseMove={e  => p && tip && setTip({ port: p, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setTip(null)}
                style={{
                  position:    'relative',
                  width:       '100%',
                  aspectRatio: '0.65',
                  borderRadius: 3,
                  background:  active ? color : `${color}33`,
                  border:      `1px solid ${active ? color : `${color}66`}`,
                  cursor:      p ? 'pointer' : 'default',
                  display:     'flex',
                  flexDirection:'column',
                  alignItems:  'center',
                  justifyContent: 'flex-end',
                  paddingBottom: 2,
                  transition:  'background 0.12s, border-color 0.12s, box-shadow 0.12s',
                  boxShadow:   active ? `0 0 8px ${color}88` : 'none',
                }}
              >
                {/* Activity LED */}
                {p && status !== 'empty' && (
                  <div style={{
                    position:    'absolute',
                    top:         3,
                    left:        '50%',
                    transform:   'translateX(-50%)',
                    width:       4,
                    height:      4,
                    borderRadius:'50%',
                    background:  color,
                    boxShadow:   `0 0 4px ${color}`,
                  }} />
                )}
                <span style={{
                  fontSize:  6,
                  color:     active ? '#fff' : `${color}bb`,
                  fontWeight: 700,
                  lineHeight: 1,
                }}>
                  {slot}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
        {(Object.entries(STATUS_COLORS) as [PortStatus['status'], string][]).map(([s, c]) => (
          <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-dim)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </span>
        ))}
      </div>

      {tip && <PortTooltip {...tip} />}
    </div>
  )
}

// ── Port Detail Panel ─────────────────────────────────────────────────────────

function PortDetailPanel({
  port, livePort, device, onClose, panelRef,
}: {
  port:     PortStatus
  livePort: PortStatus | null
  device:   DeviceDetail | null
  onClose:  () => void
  panelRef: React.RefObject<HTMLDivElement | null>
}) {
  const navigate   = useNavigate()
  const p          = livePort ?? port
  const totalErrors = p.rx_errors_1h + p.tx_errors_1h
  const errors24h   = device?.port_errors_24h ?? []

  return (
    <div
      ref={panelRef}
      style={{
        position:   'fixed',
        top:        0,
        right:      0,
        height:     '100vh',
        width:      380,
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-bright)',
        zIndex:     1000,
        display:    'flex',
        flexDirection: 'column',
        overflowY:  'auto',
        boxShadow:  '-8px 0 32px rgba(0,0,0,0.55)',
        animation:  'slideInRight 0.22s ease',
      }}
    >
      {/* Header */}
      <div style={{
        padding:      '16px 20px',
        borderBottom: '1px solid var(--border)',
        display:      'flex',
        alignItems:   'flex-start',
        justifyContent: 'space-between',
        flexShrink:   0,
      }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: '0 0 2px' }}>
            {p.port_name ?? p.port_id}
          </h2>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
            {p.switch_name ?? p.switch_id}
          </p>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            padding: '4px 6px', color: 'var(--text-dim)',
            display: 'flex', alignItems: 'center',
          }}
        >
          <X size={14} />
        </button>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Status badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            background:     `${STATUS_COLORS[p.status]}1a`,
            border:         `1px solid ${STATUS_COLORS[p.status]}55`,
            color:          STATUS_COLORS[p.status],
            borderRadius:   100,
            padding:        '3px 11px',
            fontSize:       11,
            fontWeight:     700,
            textTransform:  'uppercase',
            letterSpacing:  '0.06em',
          }}>
            {p.status}
          </span>
          {totalErrors > 0 && (
            <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>
              {totalErrors} errors (1 h)
            </span>
          )}
        </div>

        {/* Device card */}
        <div style={{
          background:   'var(--bg-raised)',
          border:       '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding:      '12px 14px',
        }}>
          {p.device_name || p.device_ip ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: 'var(--accent)' }}>
                  <DeviceIcon type={device?.device_type} />
                </span>
                <span style={{ fontWeight: 600, color: 'var(--text-head)', fontSize: 13 }}>
                  {device?.hostname ?? p.device_name ?? 'Unknown Device'}
                </span>
                {device && (
                  <span style={{
                    marginLeft: 'auto',
                    width: 7, height: 7, borderRadius: '50%',
                    background: device.is_online ? '#22c55e' : '#6b7280',
                    boxShadow: device.is_online ? '0 0 5px #22c55e' : 'none',
                  }} />
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {p.device_ip && (
                  <Row label="IP" value={p.device_ip} mono />
                )}
                {device?.mac && (
                  <Row label="MAC" value={device.mac} mono small />
                )}
                {device?.device_type && (
                  <Row label="Type" value={device.device_type} />
                )}
              </div>
            </>
          ) : (
            <p style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', margin: 0 }}>
              No device connected
            </p>
          )}
        </div>

        {/* Current rates */}
        <div>
          <SectionLabel>Current Rates</SectionLabel>
          <div style={{ display: 'flex', gap: 10 }}>
            <RateCard dir="rx" value={bps(p.rx_bytes_rate)} />
            <RateCard dir="tx" value={bps(p.tx_bytes_rate)} />
          </div>
        </div>

        {/* Error chart */}
        <div>
          <SectionLabel>Errors (24 h)</SectionLabel>
          {errors24h.length > 0 ? (
            <div style={{ height: 100 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={errors24h} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
                  <XAxis dataKey="time" hide />
                  <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} allowDecimals={false} />
                  <ReTooltip
                    contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 6 }}
                    formatter={(v: unknown, name: unknown) => [`${v}`, name === 'rx_errors' ? 'RX errors' : 'TX errors'] as [string, string]}
                    labelFormatter={(l: unknown) => typeof l === 'string' ? new Date(l).toLocaleTimeString() : String(l)}
                  />
                  <Bar dataKey="rx_errors" stackId="e" fill="#ef4444" />
                  <Bar dataKey="tx_errors" stackId="e" fill="#f87171" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart label="No error history — collector not running" />
          )}
        </div>

        {/* Throughput chart — requires history endpoint */}
        <div>
          <SectionLabel>Throughput (1 h)</SectionLabel>
          <EmptyChart label="Historical throughput requires collector" />
        </div>

        {/* Investigate button */}
        {p.device_ip && (
          <button
            onClick={() => navigate(`/network/investigate?ip=${p.device_ip}`)}
            style={{
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            6,
              padding:        '10px 16px',
              borderRadius:   'var(--radius)',
              background:     'var(--accent-dim)',
              border:         '1px solid var(--border-bright)',
              color:          'var(--accent)',
              fontWeight:     600,
              fontSize:       13,
              cursor:         'pointer',
              marginTop:      4,
            }}
          >
            <ExternalLink size={14} />
            Investigate Device
          </button>
        )}
      </div>
    </div>
  )
}

// ── Tiny shared sub-components ────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize:      10,
      fontWeight:    700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color:         'var(--text-dim)',
      margin:        '0 0 8px',
    }}>
      {children}
    </p>
  )
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div style={{
      height:         88,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      background:     'var(--bg-raised)',
      borderRadius:   'var(--radius)',
      color:          'var(--text-dim)',
      fontSize:       11,
    }}>
      {label}
    </div>
  )
}

function Row({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span style={{
        fontFamily: mono ? 'monospace' : undefined,
        fontSize:   small ? 11 : undefined,
        color:      'var(--text)',
      }}>
        {value}
      </span>
    </div>
  )
}

function RateCard({ dir, value }: { dir: 'rx' | 'tx'; value: string }) {
  const color = dir === 'rx' ? '#22c55e' : '#3b82f6'
  return (
    <div style={{
      flex:         1,
      background:   'var(--bg-raised)',
      border:       '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding:      '10px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        {dir === 'rx' ? <ArrowDown size={11} color={color} /> : <ArrowUp size={11} color={color} />}
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {dir.toUpperCase()}
        </span>
      </div>
      <p style={{ fontSize: 17, fontWeight: 700, color, margin: 0, lineHeight: 1 }}>{value}</p>
    </div>
  )
}

function SortIcon({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol; sortDir: 'asc' | 'desc' }) {
  if (sortCol !== col) return <ChevronUp size={10} style={{ opacity: 0.25 }} />
  return sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function NetworkPorts() {
  const [allPorts, setAllPorts]             = useState<PortStatus[]>([])
  const [loading, setLoading]               = useState(true)
  const [selectedSwitch, setSelectedSwitch] = useState<string>('')
  const [search, setSearch]                 = useState('')
  const [filter, setFilter]                 = useState<Filter>('all')
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null)
  const [selectedSwitchId, setSelectedSwitchId] = useState<string | null>(null)
  const [highlightedPort, setHighlightedPort] = useState<string | null>(null)
  const [device, setDevice]                 = useState<DeviceDetail | null>(null)
  const [sortCol, setSortCol]               = useState<SortCol>('errors')
  const [sortDir, setSortDir]               = useState<'asc' | 'desc'>('desc')
  const [page, setPage]                     = useState(1)
  const panelRef                            = useRef<HTMLDivElement>(null)
  const switchInitRef                       = useRef(false)

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchPorts = useCallback(async () => {
    try {
      const res = await fetch('/api/network/ports')
      if (!res.ok) return
      const data: PortStatus[] = await res.json()
      setAllPorts(data)
      setLoading(false)
      if (!switchInitRef.current && data.length > 0) {
        setSelectedSwitch(data[0].switch_id)
        switchInitRef.current = true
      }
    } catch {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPorts()
    const id = setInterval(fetchPorts, 10_000)
    return () => clearInterval(id)
  }, [fetchPorts])

  // Load device detail whenever selected port's IP is known
  const selectedPort = allPorts.find(
    p => p.port_id === selectedPortId && p.switch_id === selectedSwitchId
  ) ?? null

  useEffect(() => {
    if (!selectedPort?.device_ip) { setDevice(null); return }
    fetch(`/api/network/device/${selectedPort.device_ip}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: DeviceDetail | null) => setDevice(d))
      .catch(() => setDevice(null))
  }, [selectedPort?.device_ip])

  // Click-outside closes panel
  useEffect(() => {
    if (!selectedPortId) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setSelectedPortId(null)
        setSelectedSwitchId(null)
        setHighlightedPort(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [selectedPortId])

  // ── Derived data ──────────────────────────────────────────────────────────

  const switches = Array.from(
    new Map(allPorts.map(p => [p.switch_id, p.switch_name ?? p.switch_id]))
  )

  const switchPorts = allPorts.filter(p => p.switch_id === selectedSwitch)

  const filtered = switchPorts.filter(p => {
    if (search) {
      const q = search.toLowerCase()
      if (
        !(p.device_name ?? '').toLowerCase().includes(q) &&
        !(p.device_ip   ?? '').toLowerCase().includes(q)
      ) return false
    }
    if (filter === 'errors')       return p.rx_errors_1h > 0 || p.tx_errors_1h > 0
    if (filter === 'high_traffic') return p.rx_bytes_rate > HIGH_TRAFFIC_BPS || p.tx_bytes_rate > HIGH_TRAFFIC_BPS
    if (filter === 'empty')        return p.status === 'empty'
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    let av: number | string = 0
    let bv: number | string = 0
    if (sortCol === 'port')       { av = portNum(a);                           bv = portNum(b) }
    if (sortCol === 'device')     { av = a.device_name ?? '';                  bv = b.device_name ?? '' }
    if (sortCol === 'ip')         { av = a.device_ip ?? '';                    bv = b.device_ip ?? '' }
    if (sortCol === 'rx')         { av = a.rx_bytes_rate;                      bv = b.rx_bytes_rate }
    if (sortCol === 'tx')         { av = a.tx_bytes_rate;                      bv = b.tx_bytes_rate }
    if (sortCol === 'errors')     { av = a.rx_errors_1h + a.tx_errors_1h;      bv = b.rx_errors_1h + b.tx_errors_1h }
    if (sortCol === 'status')     { av = a.status;                             bv = b.status }
    if (sortCol === 'last_error') { av = a.last_error_time ?? '';              bv = b.last_error_time ?? '' }
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ?  1 : -1
    return 0
  })

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const pageRows   = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
    setPage(1)
  }

  function openPort(p: PortStatus) {
    setSelectedPortId(p.port_id)
    setSelectedSwitchId(p.switch_id)
    setHighlightedPort(p.port_id)
  }

  function closePanel() {
    setSelectedPortId(null)
    setSelectedSwitchId(null)
    setHighlightedPort(null)
  }

  const TABLE_COLS: [SortCol, string][] = [
    ['port',       'Port'],
    ['device',     'Device'],
    ['ip',         'IP'],
    ['rx',         'RX/s'],
    ['tx',         'TX/s'],
    ['errors',     'Errors (1h)'],
    ['status',     'Status'],
    ['last_error', 'Last Error'],
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Slide-in keyframe — injected once */}
      <style>{`@keyframes slideInRight { from { transform: translateX(100%) } to { transform: translateX(0) } }`}</style>

      <div style={{
        padding:       16,
        height:        '100%',
        overflow:      'auto',
        display:       'flex',
        flexDirection: 'column',
        gap:           12,
        position:      'relative',
      }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
          <div style={{
            width: 32, height: 32, borderRadius: 'var(--radius)',
            background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Plug size={16} color="var(--accent)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
              Switch Ports
            </h1>
            <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
              Live port status — refreshes every 10 s
            </p>
          </div>

          {/* Switch selector */}
          {switches.length > 1 && (
            <select
              value={selectedSwitch}
              onChange={e => { setSelectedSwitch(e.target.value); setPage(1) }}
              style={{
                background:   'var(--bg-raised)',
                border:       '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color:        'var(--text)',
                fontSize:     12,
                padding:      '5px 10px',
                cursor:       'pointer',
              }}
            >
              {switches.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{
              position: 'absolute', left: 9, top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-dim)', pointerEvents: 'none',
            }} />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Device or IP"
              style={{
                background:   'var(--bg-raised)',
                border:       '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color:        'var(--text)',
                fontSize:     12,
                padding:      '5px 10px 5px 28px',
                width:        160,
                outline:      'none',
              }}
            />
          </div>

          {/* Filter buttons */}
          <div style={{ display: 'flex', gap: 3 }}>
            {FILTERS.map(f => (
              <button
                key={f}
                onClick={() => { setFilter(f); setPage(1) }}
                style={{
                  padding:      '4px 10px',
                  fontSize:     11,
                  fontWeight:   600,
                  borderRadius: 'var(--radius-sm)',
                  cursor:       'pointer',
                  border:       filter === f ? '1px solid var(--border-bright)' : '1px solid transparent',
                  background:   filter === f ? 'var(--bg-raised)' : 'transparent',
                  color:        filter === f ? 'var(--text-head)' : 'var(--text-dim)',
                }}
              >
                {FILTER_LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        {/* ── Loading skeleton ────────────────────────────────────────────── */}
        {loading && (
          <div className="card" style={{
            height: 180, animation: 'pulse 1.4s ease-in-out infinite',
          }} />
        )}

        {/* ── Switch diagram ──────────────────────────────────────────────── */}
        {!loading && switchPorts.length > 0 && (
          <SwitchDiagram
            ports={switchPorts}
            selected={highlightedPort}
            highlighted={highlightedPort}
            onSelect={openPort}
          />
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {!loading && switchPorts.length === 0 && (
          <div className="card" style={{ padding: 40, textAlign: 'center' }}>
            <Plug size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>
              No port data available
            </p>
            <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              Deploy the collector stack with a UniFi switch to begin receiving port metrics.
            </p>
          </div>
        )}

        {/* ── Port table ──────────────────────────────────────────────────── */}
        {!loading && filtered.length > 0 && (
          <div className="card" style={{ overflow: 'auto', flexShrink: 0 }}>
            {/* Export row */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 0' }}>
              <button
                onClick={() => {
                  const header = ['Port', 'Device', 'IP', 'RX rate', 'TX rate', 'Errors (1h)', 'Status']
                  const rows = sorted.map(p => [
                    p.port_name ?? p.port_id,
                    p.device_name ?? '',
                    p.device_ip ?? '',
                    p.rx_bytes_rate,
                    p.tx_bytes_rate,
                    p.rx_errors_1h + p.tx_errors_1h,
                    p.status,
                  ])
                  const csv = [header, ...rows].map(r => r.join(',')).join('\n')
                  const a = Object.assign(document.createElement('a'), {
                    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
                    download: `ports_${new Date().toISOString().slice(0, 10)}.csv`,
                  })
                  a.click()
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'none', border: '1px solid var(--border)',
                  color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)',
                  padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                }}
              >
                <Download size={11} /> Export CSV
              </button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {TABLE_COLS.map(([col, label]) => (
                    <th
                      key={col}
                      onClick={() => toggleSort(col)}
                      style={{
                        padding:       '8px 12px',
                        textAlign:     'left',
                        cursor:        'pointer',
                        fontSize:      10,
                        fontWeight:    700,
                        letterSpacing: '0.06em',
                        color:         sortCol === col ? 'var(--text-head)' : 'var(--text-dim)',
                        textTransform: 'uppercase',
                        userSelect:    'none',
                        whiteSpace:    'nowrap',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        {label}
                        <SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p, i) => {
                  const errors     = p.rx_errors_1h + p.tx_errors_1h
                  const isSelected = p.port_id === highlightedPort
                  return (
                    <tr
                      key={i}
                      onClick={() => openPort(p)}
                      style={{
                        borderBottom: '1px solid var(--border-dim)',
                        cursor:       'pointer',
                        background:   isSelected ? 'var(--bg-raised)' : 'transparent',
                        transition:   'background 0.1s',
                      }}
                    >
                      <td style={{ padding: '8px 12px', color: 'var(--text)', fontWeight: 500 }}>
                        {p.port_name ?? p.port_id}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>
                        {p.device_name ?? '—'}
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                        {p.device_ip ?? '—'}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#22c55e' }}>
                          <ArrowDown size={9} />
                          {bps(p.rx_bytes_rate)}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#3b82f6' }}>
                          <ArrowUp size={9} />
                          {bps(p.tx_bytes_rate)}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        {errors > 0
                          ? <span style={{ color: '#ef4444', fontWeight: 700 }}>{errors}</span>
                          : <span style={{ color: 'var(--text-dim)' }}>0</span>
                        }
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          fontSize:      10,
                          fontWeight:    700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color:         STATUS_COLORS[p.status],
                        }}>
                          {p.status}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-dim)', fontSize: 11 }}>
                        {p.last_error_time
                          ? new Date(p.last_error_time).toLocaleString()
                          : '—'
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{
                padding:     '10px 16px',
                display:     'flex',
                alignItems:  'center',
                gap:         6,
                borderTop:   '1px solid var(--border-dim)',
                flexWrap:    'wrap',
              }}>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: 1 }}>
                  {sorted.length} ports — page {page} of {totalPages}
                </span>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(pg => (
                  <button
                    key={pg}
                    onClick={() => setPage(pg)}
                    style={{
                      width:        28,
                      height:       28,
                      borderRadius: 'var(--radius-sm)',
                      border:       pg === page ? '1px solid var(--border-bright)' : '1px solid transparent',
                      background:   pg === page ? 'var(--bg-raised)' : 'transparent',
                      color:        pg === page ? 'var(--text-head)' : 'var(--text-dim)',
                      fontSize:     12,
                      cursor:       'pointer',
                      fontWeight:   pg === page ? 700 : 400,
                    }}
                  >
                    {pg}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Port detail panel ─────────────────────────────────────────────── */}
      {selectedPort && (
        <PortDetailPanel
          port={selectedPort}
          livePort={selectedPort}
          device={device}
          onClose={closePanel}
          panelRef={panelRef}
        />
      )}
    </>
  )
}
