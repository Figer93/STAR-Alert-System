import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plug, Search, X, ExternalLink,
  ArrowDown, ArrowUp, ChevronUp, ChevronDown,
  Server, Monitor, Wifi as WifiIcon, Router, HardDrive, Download,
} from 'lucide-react'
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  Tooltip as ReTooltip, ResponsiveContainer,
} from 'recharts'
import { Drawer } from 'vaul'

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
  errors_24h:      Array<{ time: string; rx_errors: number; tx_errors: number }>
  throughput_1h:   Array<{ time: string; rx_bytes_rate: number; tx_bytes_rate: number }>
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
  empty:   '#27272a',
  uplink:  '#3b82f6',
}

const PORTS_PER_ROW    = 24
const HIGH_TRAFFIC_BPS = 10_000_000
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

function effectiveDeviceName(p: PortStatus): string | null {
  if (!p.device_name) return null
  if (p.device_name === p.port_name) return null
  return p.device_name
}

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
      background:   'var(--bg-elevated)',
      border:       '1px solid var(--border-bright)',
      borderRadius: 5,
      padding:      '8px 12px',
      fontSize:     12,
      pointerEvents:'none',
      minWidth:     180,
      boxShadow:    '0 8px 24px rgba(0,0,0,0.6)',
    }}>
      <p style={{ fontWeight: 700, color: 'var(--text-head)', margin: '0 0 4px' }}>
        {p.port_name ?? p.port_id}
      </p>
      {effectiveDeviceName(p) && (
        <p style={{ color: 'var(--text)', margin: '0 0 2px' }}>{effectiveDeviceName(p)}</p>
      )}
      {p.device_ip && (
        <p style={{ color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, margin: '0 0 6px' }}>
          {p.device_ip}
        </p>
      )}
      <div style={{ display: 'flex', gap: 14 }}>
        <span style={{ color: '#22c55e', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>↓ {bps(p.rx_bytes_rate)}</span>
        <span style={{ color: '#3b82f6', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>↑ {bps(p.tx_bytes_rate)}</span>
      </div>
      {(p.rx_errors_1h > 0 || p.tx_errors_1h > 0) && (
        <p style={{ color: '#ef4444', margin: '5px 0 0', fontSize: 11, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
          {p.rx_errors_1h + p.tx_errors_1h} errors (1 h)
        </p>
      )}
    </div>
  )
}

// ── Switch Diagram ────────────────────────────────────────────────────────────

function SwitchDiagram({
  ports, selected, onSelect,
}: {
  ports:    PortStatus[]
  selected: string | null
  onSelect: (p: PortStatus) => void
}) {
  const [tip, setTip] = useState<TooltipPos | null>(null)

  const slotMap = new Map<number, PortStatus>()
  let maxSlot = PORTS_PER_ROW
  for (const p of ports) {
    const n = portNum(p)
    if (n > 0) {
      slotMap.set(n, p)
      if (n > maxSlot) maxSlot = Math.ceil(n / PORTS_PER_ROW) * PORTS_PER_ROW
    }
  }
  let overflow = maxSlot + 1
  for (const p of ports) {
    if (portNum(p) === 0) slotMap.set(overflow++, p)
  }

  const total = Math.max(maxSlot, overflow - 1)
  const slots = Array.from({ length: total }, (_, i) => i + 1)

  // Rows of 24
  const rows: number[][] = []
  for (let i = 0; i < slots.length; i += PORTS_PER_ROW) {
    rows.push(slots.slice(i, i + PORTS_PER_ROW))
  }

  return (
    <div style={{
      width:        '100%',
      background:   '#0f0f12',
      border:       '1px solid rgba(255,255,255,0.06)',
      borderRadius: 8,
      padding:      24,
    }}>
      {/* Chassis rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            {row.map(slot => {
              const p      = slotMap.get(slot)
              const status = p?.status ?? 'empty'
              const color  = STATUS_COLORS[status]
              const active = p?.port_id === selected

              const ledBg: string = {
                healthy: '#22c55e',
                error:   '#ef4444',
                warning: '#f59e0b',
                empty:   '#3f3f46',
                uplink:  '#60a5fa',
              }[status]

              const ledShadow: string = {
                healthy: '0 0 6px #22c55e, 0 0 12px #22c55e40',
                error:   '0 0 6px #ef4444',
                warning: '0 0 6px #f59e0b',
                uplink:  '0 0 6px #60a5fa',
                empty:   'none',
              }[status]

              return (
                <div
                  key={slot}
                  title={p ? `${p.port_name ?? p.port_id}${p.device_ip ? ` — ${p.device_ip}` : ''}` : undefined}
                  onClick={() => p && onSelect(p)}
                  onMouseEnter={e => p && setTip({ port: p, x: e.clientX, y: e.clientY })}
                  onMouseMove={e  => p && tip && setTip({ port: p, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setTip(null)}
                  style={{
                    width:        14,
                    height:       44,
                    borderRadius: 3,
                    background:   status === 'empty' ? '#1c1c1f' : active ? color : `${color}33`,
                    border:       `1px solid ${active ? color : `${color}55`}`,
                    outline:      active ? '1px solid #60a5fa' : 'none',
                    outlineOffset: active ? 2 : 0,
                    cursor:       p ? 'pointer' : 'default',
                    transition:   'filter 0.1s',
                    filter:       'brightness(1)',
                    flexShrink:   0,
                    position:     'relative',
                    display:      'flex',
                    flexDirection:'column',
                    alignItems:   'center',
                    justifyContent: 'space-between',
                    paddingBottom: 3,
                  }}
                  onMouseOver={e => { if (p) (e.currentTarget as HTMLDivElement).style.filter = 'brightness(1.3)' }}
                  onMouseOut={e  => { (e.currentTarget as HTMLDivElement).style.filter = 'brightness(1)' }}
                >
                  {/* LED dot */}
                  <div style={{
                    width:        6,
                    height:       6,
                    borderRadius: '50%',
                    marginTop:    4,
                    background:   ledBg,
                    boxShadow:    ledShadow,
                    flexShrink:   0,
                  }} />
                  {/* Port number */}
                  <span style={{
                    fontSize:   8,
                    fontFamily: 'monospace',
                    color:      'rgba(255,255,255,0.3)',
                    lineHeight: 1,
                    userSelect: 'none',
                  }}>
                    {slot}
                  </span>
                </div>
              )
            })}
            {/* Row label */}
            <span style={{
              fontSize:   10,
              color:      '#52525b',
              marginLeft: 6,
              lineHeight: 1,
              flexShrink: 0,
              userSelect: 'none',
            }}>
              {ri * PORTS_PER_ROW + 1}–{Math.min((ri + 1) * PORTS_PER_ROW, total)}
            </span>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        {(Object.entries(STATUS_COLORS) as [PortStatus['status'], string][]).map(([s, c]) => (
          <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-dim)' }}>
            <span style={{ width: 9, height: 9, borderRadius: 1, background: c, display: 'inline-block' }} />
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </span>
        ))}
      </div>

      {tip && <PortTooltip {...tip} />}
    </div>
  )
}

// ── Port Detail Drawer (vaul) ─────────────────────────────────────────────────

function PortDetailDrawer({
  port, device, open, onOpenChange,
}: {
  port:         PortStatus | null
  device:       DeviceDetail | null
  open:         boolean
  onOpenChange: (v: boolean) => void
}) {
  const navigate = useNavigate()
  if (!port) return null

  const p           = port
  const totalErrors = p.rx_errors_1h + p.tx_errors_1h
  const errors24h   = (p.errors_24h ?? []).map(b => ({
    time:      new Date(b.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    rx_errors: b.rx_errors,
    tx_errors: b.tx_errors,
  }))
  const throughput1h = (p.throughput_1h ?? []).map(b => ({
    time:   new Date(b.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    rx_bps: b.rx_bytes_rate,
    tx_bps: b.tx_bytes_rate,
  }))

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      direction="right"
    >
      <Drawer.Portal>
        <Drawer.Overlay style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(2px)',
          zIndex: 100,
        }} />
        <Drawer.Content style={{
          position:      'fixed',
          top:           0,
          right:         0,
          bottom:        0,
          width:         380,
          background:    'var(--bg-surface)',
          borderLeft:    '1px solid var(--border-bright)',
          zIndex:        101,
          display:       'flex',
          flexDirection: 'column',
          overflowY:     'auto',
          boxShadow:     '-12px 0 40px rgba(0,0,0,0.6)',
          outline:       'none',
        }}>
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
              onClick={() => onOpenChange(false)}
              style={{
                background: 'none', border: '1px solid var(--border)',
                borderRadius: 4, cursor: 'pointer',
                padding: '4px 6px', color: 'var(--text-dim)',
                display: 'flex', alignItems: 'center',
              }}
            >
              <X size={13} />
            </button>
          </div>

          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Status + errors */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                background:    `${STATUS_COLORS[p.status]}18`,
                border:        `1px solid ${STATUS_COLORS[p.status]}44`,
                color:         STATUS_COLORS[p.status],
                borderRadius:  3,
                padding:       '3px 10px',
                fontSize:      10,
                fontWeight:    700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {p.status}
              </span>
              {totalErrors > 0 && (
                <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
                  {totalErrors} errors (1h)
                </span>
              )}
            </div>

            {/* Device card */}
            <div style={{
              background:   'var(--bg-raised)',
              border:       '1px solid var(--border)',
              borderRadius: 5,
              padding:      '12px 14px',
            }}>
              {effectiveDeviceName(p) || p.device_ip ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ color: 'var(--accent)' }}>
                      <DeviceIcon type={device?.device_type} />
                    </span>
                    <span style={{ fontWeight: 600, color: 'var(--text-head)', fontSize: 13, flex: 1 }}>
                      {device?.hostname ?? effectiveDeviceName(p) ?? 'Unknown Device'}
                    </span>
                    {device && (
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: device.is_online ? '#22c55e' : 'var(--text-dim)',
                        boxShadow: device.is_online ? '0 0 5px #22c55e' : 'none',
                        flexShrink: 0,
                      }} />
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {p.device_ip && <DataRow label="IP"  value={p.device_ip} mono />}
                    {device?.mac && <DataRow label="MAC" value={device.mac} mono />}
                    {device?.device_type && <DataRow label="Type" value={device.device_type} />}
                  </div>
                </>
              ) : (
                <p style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', margin: 0 }}>
                  No device connected
                </p>
              )}
            </div>

            {/* RX/TX rates */}
            <div>
              <SectionLabel>Current Rates</SectionLabel>
              <div style={{ display: 'flex', gap: 8 }}>
                <RateCard dir="rx" value={bps(p.rx_bytes_rate)} />
                <RateCard dir="tx" value={bps(p.tx_bytes_rate)} />
              </div>
            </div>

            {/* Error history sparkline */}
            <div>
              <SectionLabel>Errors (24h)</SectionLabel>
              {errors24h.length > 0 ? (
                <div style={{ height: 90 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={errors24h} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
                      <XAxis dataKey="time" hide />
                      <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }} allowDecimals={false} />
                      <ReTooltip
                        contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 5 }}
                        formatter={(v: unknown, name: unknown) => [`${v}`, name === 'rx_errors' ? 'RX errors' : 'TX errors'] as [string, string]}
                      />
                      <Bar dataKey="rx_errors" stackId="e" fill="#ef4444" />
                      <Bar dataKey="tx_errors" stackId="e" fill="#f87171" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyChart label="No error history" />
              )}
            </div>

            {/* Throughput oscilloscope */}
            <div>
              <SectionLabel>Throughput (1h)</SectionLabel>
              {throughput1h.length > 0 ? (
                <div style={{ height: 90 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={throughput1h} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
                      <XAxis dataKey="time" hide />
                      <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickFormatter={v => bps(v)} />
                      <ReTooltip
                        contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 5 }}
                        formatter={(v: unknown, name: unknown) => [bps(Number(v)), name === 'rx_bps' ? 'RX' : 'TX'] as [string, string]}
                      />
                      <Area dataKey="rx_bps" stroke="#22c55e" strokeWidth={1} fill="none" dot={false} />
                      <Area dataKey="tx_bps" stroke="#3b82f6" strokeWidth={1} fill="none" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyChart label="No throughput data yet" />
              )}
            </div>

            {/* Investigate */}
            {p.device_ip && (
              <button
                onClick={() => { navigate(`/network/investigate?ip=${p.device_ip}`); onOpenChange(false) }}
                style={{
                  display:        'flex',
                  alignItems:     'center',
                  justifyContent: 'center',
                  gap:            6,
                  padding:        '9px 16px',
                  borderRadius:   5,
                  background:     'var(--accent-dim)',
                  border:         '1px solid var(--border-bright)',
                  color:          'var(--accent)',
                  fontWeight:     600,
                  fontSize:       13,
                  cursor:         'pointer',
                }}
              >
                <ExternalLink size={13} />
                Investigate Device
              </button>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 8px' }}>
      {children}
    </p>
  )
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-raised)', borderRadius: 4, color: 'var(--text-dim)', fontSize: 11 }}>
      {label}
    </div>
  )
}

function DataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'JetBrains Mono, monospace' : undefined, color: 'var(--text)' }}>
        {value}
      </span>
    </div>
  )
}

function RateCard({ dir, value }: { dir: 'rx' | 'tx'; value: string }) {
  const color = dir === 'rx' ? '#22c55e' : '#3b82f6'
  return (
    <div style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        {dir === 'rx' ? <ArrowDown size={11} color={color} /> : <ArrowUp size={11} color={color} />}
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {dir.toUpperCase()}
        </span>
      </div>
      <p style={{ fontSize: 17, fontWeight: 700, color, margin: 0, lineHeight: 1, fontFamily: 'JetBrains Mono, monospace' }}>{value}</p>
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
  const [drawerOpen, setDrawerOpen]         = useState(false)
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null)
  const [selectedSwitchId, setSelectedSwitchId] = useState<string | null>(null)
  const [device, setDevice]                 = useState<DeviceDetail | null>(null)
  const [sortCol, setSortCol]               = useState<SortCol>('errors')
  const [sortDir, setSortDir]               = useState<'asc' | 'desc'>('desc')
  const [page, setPage]                     = useState(1)
  const switchInitRef                       = useRef(false)

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
    if (sortCol === 'port')       { av = portNum(a);                      bv = portNum(b) }
    if (sortCol === 'device')     { av = a.device_name ?? '';             bv = b.device_name ?? '' }
    if (sortCol === 'ip')         { av = a.device_ip ?? '';               bv = b.device_ip ?? '' }
    if (sortCol === 'rx')         { av = a.rx_bytes_rate;                 bv = b.rx_bytes_rate }
    if (sortCol === 'tx')         { av = a.tx_bytes_rate;                 bv = b.tx_bytes_rate }
    if (sortCol === 'errors')     { av = a.rx_errors_1h + a.tx_errors_1h; bv = b.rx_errors_1h + b.tx_errors_1h }
    if (sortCol === 'status')     { av = a.status;                        bv = b.status }
    if (sortCol === 'last_error') { av = a.last_error_time ?? '';         bv = b.last_error_time ?? '' }
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
    setDrawerOpen(true)
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

  return (
    <>
      <div style={{
        padding:       14,
        height:        '100%',
        overflow:      'auto',
        display:       'flex',
        flexDirection: 'column',
        gap:           10,
      }}>

        {/* Header bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          {/* Switch selector */}
          {switches.length > 1 && (
            <select
              value={selectedSwitch}
              onChange={e => { setSelectedSwitch(e.target.value); setPage(1) }}
              style={{
                background:   'var(--bg-raised)',
                border:       '1px solid var(--border-bright)',
                borderRadius: 4,
                color:        'var(--text-head)',
                fontSize:     12,
                padding:      '5px 10px',
                cursor:       'pointer',
                outline:      'none',
              }}
            >
              {switches.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Device or IP"
              style={{
                background:   'var(--bg-raised)',
                border:       '1px solid var(--border-bright)',
                borderRadius: 4,
                color:        'var(--text-head)',
                fontSize:     12,
                padding:      '5px 10px 5px 28px',
                width:        160,
                outline:      'none',
              }}
            />
          </div>

          {/* Filter chips */}
          <div style={{ display: 'flex', gap: 3 }}>
            {FILTERS.map(f => (
              <button
                key={f}
                onClick={() => { setFilter(f); setPage(1) }}
                style={{
                  padding:      '4px 10px',
                  fontSize:     11,
                  fontWeight:   600,
                  borderRadius: 3,
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

          <div style={{ flex: 1 }} />

          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            refreshes every 10s
          </span>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="skeleton card" style={{ height: 140 }} />
        )}

        {/* Switch diagram */}
        {!loading && switchPorts.length > 0 && (
          <SwitchDiagram
            ports={switchPorts}
            selected={selectedPortId}
            onSelect={openPort}
          />
        )}

        {/* Empty state */}
        {!loading && switchPorts.length === 0 && (
          <div className="card" style={{ padding: 40, textAlign: 'center' }}>
            <Plug size={32} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>No port data available</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              Deploy the collector stack with a UniFi switch to begin receiving port metrics.
            </p>
          </div>
        )}

        {/* Port table */}
        {!loading && filtered.length > 0 && (
          <div className="card" style={{ overflow: 'auto', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 0' }}>
              <button
                onClick={() => {
                  const header = ['Port', 'Device', 'IP', 'RX rate', 'TX rate', 'Errors (1h)', 'Status']
                  const rows = sorted.map(p => [
                    p.port_name ?? p.port_id, p.device_name ?? '',
                    p.device_ip ?? '', p.rx_bytes_rate, p.tx_bytes_rate,
                    p.rx_errors_1h + p.tx_errors_1h, p.status,
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
                  color: 'var(--text-muted)', borderRadius: 3,
                  padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                }}
              >
                <Download size={11} /> Export CSV
              </button>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  {TABLE_COLS.map(([col, label]) => (
                    <th
                      key={col}
                      onClick={() => toggleSort(col)}
                      style={{ color: sortCol === col ? 'var(--text-head)' : undefined }}
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
                  const isSelected = p.port_id === selectedPortId
                  return (
                    <tr
                      key={i}
                      onClick={() => openPort(p)}
                      style={{
                        cursor:     'pointer',
                        background: isSelected ? 'var(--bg-raised)' : undefined,
                      }}
                    >
                      <td style={{ fontWeight: 500 }}>{p.port_name ?? p.port_id}</td>
                      <td style={{ color: 'var(--text-dim)' }}>{effectiveDeviceName(p) ?? '—'}</td>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{p.device_ip ?? '—'}</td>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#22c55e', fontFamily: 'JetBrains Mono, monospace' }}>
                          <ArrowDown size={9} />{bps(p.rx_bytes_rate)}
                        </span>
                      </td>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#3b82f6', fontFamily: 'JetBrains Mono, monospace' }}>
                          <ArrowUp size={9} />{bps(p.tx_bytes_rate)}
                        </span>
                      </td>
                      <td>
                        {errors > 0
                          ? <span style={{ color: '#ef4444', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{errors}</span>
                          : <span style={{ color: 'var(--text-dim)' }}>0</span>
                        }
                      </td>
                      <td>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: STATUS_COLORS[p.status] }}>
                          {p.status}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                        {p.last_error_time ? new Date(p.last_error_time).toLocaleString() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px solid var(--border-dim)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: 1, fontFamily: 'JetBrains Mono, monospace' }}>
                  {sorted.length} ports — page {page} of {totalPages}
                </span>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(pg => (
                  <button
                    key={pg}
                    onClick={() => setPage(pg)}
                    style={{
                      width: 28, height: 28,
                      borderRadius: 3,
                      border:     pg === page ? '1px solid var(--border-bright)' : '1px solid transparent',
                      background: pg === page ? 'var(--bg-raised)' : 'transparent',
                      color:      pg === page ? 'var(--text-head)' : 'var(--text-dim)',
                      fontSize:   12, cursor: 'pointer',
                      fontWeight: pg === page ? 700 : 400,
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

      {/* Port detail drawer */}
      <PortDetailDrawer
        port={selectedPort}
        device={device}
        open={drawerOpen}
        onOpenChange={v => {
          setDrawerOpen(v)
          if (!v) setSelectedPortId(null)
        }}
      />
    </>
  )
}
