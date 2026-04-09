import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Monitor, Server, Printer, Wifi as WifiIcon,
  HelpCircle, ChevronUp, ChevronDown, ChevronsUpDown,
  ExternalLink, Edit2, Check, X, Trash2, AlertTriangle,
  RefreshCw, Download,
} from 'lucide-react'
import { Drawer } from 'vaul'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeviceRow {
  ip:          string
  mac:         string | null
  hostname:    string | null
  switch_id:   string | null
  switch_name: string | null
  port_id:     string | null
  last_seen:   string | null
  first_seen:  string | null
  is_online:   boolean
  device_type: string | null
  notes:       string | null
}

interface DeviceDetail {
  ip:                     string
  mac:                    string | null
  hostname:               string | null
  switch_id:              string | null
  port_id:                string | null
  device_type:            string | null
  notes:                  string | null
  is_online:              boolean
  last_seen:              string | null
  first_seen:             string | null
  current_port_status:    Record<string, unknown> | null
  port_errors_24h:        Array<{ time: string; rx_errors: number; tx_errors: number }>
  latency_to_gateway_24h: Array<{ time: string; avg_rtt: number | null }>
  incidents:              Array<Record<string, unknown>>
}

interface TimelineEvent {
  time:        string
  event_type:  string
  severity:    string
  description: string
}

interface InvestigateTimeline {
  timeline: TimelineEvent[]
}

type SortCol      = 'hostname' | 'ip' | 'last_seen' | 'device_type' | 'is_online'
type StatusFilter = 'all' | 'online' | 'offline' | 'unknown'
type DeviceType   = 'workstation' | 'server' | 'printer' | 'ap' | 'unknown'

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api/network'

const TYPE_META: Record<string, { label: string; Icon: React.ComponentType<{ size?: number }> }> = {
  workstation: { label: 'Workstation',   Icon: Monitor },
  server:      { label: 'Server',        Icon: Server },
  printer:     { label: 'Printer',       Icon: Printer },
  ap:          { label: 'Access Point',  Icon: WifiIcon },
  unknown:     { label: 'Unknown',       Icon: HelpCircle },
}

const DEVICE_TYPES: DeviceType[] = ['workstation', 'server', 'printer', 'ap', 'unknown']

const EVENT_COLORS: Record<string, string> = {
  device_offline:  'var(--red)',
  device_online:   'var(--green)',
  port_error:      'var(--amber)',
  latency_spike:   'var(--amber)',
  traffic_anomaly: 'var(--blue)',
  default:         'var(--text-muted)',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayName(hostname: string | null, mac: string | null): string {
  if (hostname) return hostname
  if (mac) {
    const last6 = mac.replace(/[^a-fA-F0-9]/g, '').slice(-6)
    const fmt   = last6.match(/.{1,2}/g)?.join(':') ?? last6
    return `Unknown (${fmt.toLowerCase()})`
  }
  return 'Unknown'
}

function ago(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${m !== 1 ? 's' : ''} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr${h !== 1 ? 's' : ''} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d !== 1 ? 's' : ''} ago`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusDot({ online }: { online: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 9, height: 9,
      borderRadius: '50%',
      flexShrink: 0,
      backgroundColor: online ? 'var(--green)' : '#4b5563',
      boxShadow: online ? '0 0 6px var(--green)' : 'none',
    }} />
  )
}

function TypeChip({ type }: { type: string | null }) {
  const meta = TYPE_META[type ?? 'unknown'] ?? TYPE_META.unknown
  const { label, Icon } = meta
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)', fontSize: 13 }}>
      <Icon size={13} />
      {label}
    </span>
  )
}

function SortTh({
  col, label, sort, onSort,
}: {
  col: SortCol
  label: string
  sort: { col: SortCol; dir: 'asc' | 'desc' }
  onSort: (c: SortCol) => void
}) {
  const active = sort.col === col
  return (
    <th
      onClick={() => onSort(col)}
      style={{
        padding: '10px 14px',
        textAlign: 'left',
        fontWeight: 500,
        fontSize: 12,
        color: active ? 'var(--blue)' : 'var(--text-muted)',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        {active
          ? sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
          : <ChevronsUpDown size={11} style={{ opacity: 0.35 }} />
        }
      </span>
    </th>
  )
}

// 24-hour timeline bar built from investigate events
function StabilityTimeline({ events }: { events: TimelineEvent[] }) {
  const now = Date.now()
  const span = 24 * 60 * 60 * 1000
  const start = now - span

  const relevant = events
    .filter(e => e.event_type === 'device_offline' || e.event_type === 'device_online')
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())

  // Build segments: [startMs, endMs, color]
  type Seg = { x: number; w: number; color: string; label: string }
  const segs: Seg[] = []

  if (relevant.length === 0) {
    // No events — assume stable online
    segs.push({ x: 0, w: 100, color: '#22c55e33', label: 'No outages detected' })
  } else {
    let cursor = start
    let currentOnline = relevant[0].event_type === 'device_online'

    for (const ev of relevant) {
      const evMs = Math.max(new Date(ev.time).getTime(), start)
      const w = ((evMs - cursor) / span) * 100
      if (w > 0) {
        segs.push({
          x: ((cursor - start) / span) * 100,
          w,
          color: currentOnline ? '#22c55e33' : '#ef444433',
          label: currentOnline ? 'Online' : 'Offline',
        })
      }
      cursor = evMs
      currentOnline = ev.event_type === 'device_online'
    }

    // Final segment to now
    const finalW = ((now - cursor) / span) * 100
    if (finalW > 0) {
      segs.push({
        x: ((cursor - start) / span) * 100,
        w: finalW,
        color: currentOnline ? '#22c55e33' : '#ef444433',
        label: currentOnline ? 'Online' : 'Offline',
      })
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Last 24 hours</p>
      <div style={{
        position: 'relative',
        height: 28,
        background: 'var(--bg-base)',
        borderRadius: 4,
        overflow: 'hidden',
        border: '1px solid var(--border)',
      }}>
        {segs.map((seg, i) => (
          <div
            key={i}
            title={seg.label}
            style={{
              position: 'absolute',
              top: 0, bottom: 0,
              left: `${seg.x}%`,
              width: `${seg.w}%`,
              backgroundColor: seg.color,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
        <span>24h ago</span>
        <span>Now</span>
      </div>
      {relevant.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
          {[...relevant].reverse().map((ev, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%', marginTop: 4, flexShrink: 0,
                backgroundColor: EVENT_COLORS[ev.event_type] ?? EVENT_COLORS.default,
              }} />
              <span style={{ color: 'var(--text-muted)' }}>{ago(ev.time)}</span>
              <span style={{ color: 'var(--text-primary)' }}>{ev.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Device Drawer (vaul) ──────────────────────────────────────────────────────

function DevicePanel({
  ip,
  open,
  onOpenChange,
  onUpdated,
  onForgotten,
}: {
  ip: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onUpdated: (d: DeviceRow) => void
  onForgotten: (ip: string) => void
}) {
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement | null>(null)

  const [detail, setDetail]           = useState<DeviceDetail | null>(null)
  const [timeline, setTimeline]       = useState<TimelineEvent[]>([])
  const [loading, setLoading]         = useState(true)

  const [editType, setEditType]       = useState<string>('')
  const [editNotes, setEditNotes]     = useState<string>('')
  const [saving, setSaving]           = useState(false)
  const [saveOk, setSaveOk]           = useState(false)

  const [confirmForget, setConfirmForget] = useState(false)
  const [forgetting, setForgetting]       = useState(false)

  // Load detail + 24h timeline in parallel
  useEffect(() => {
    if (!ip) return
    let cancelled = false
    setLoading(true)
    setDetail(null)
    setTimeline([])
    setConfirmForget(false)

    const now   = new Date()
    const ago24 = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const start = ago24.toISOString()
    const end   = now.toISOString()

    Promise.allSettled([
      fetch(`${BASE}/device/${encodeURIComponent(ip)}`).then(r => r.json() as Promise<DeviceDetail>),
      fetch(`${BASE}/investigate?ip=${encodeURIComponent(ip)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
        .then(r => r.json() as Promise<InvestigateTimeline>),
    ]).then(([detailRes, invRes]) => {
      if (cancelled) return
      if (detailRes.status === 'fulfilled') {
        const d = detailRes.value
        setDetail(d)
        setEditType(d.device_type ?? 'unknown')
        setEditNotes(d.notes ?? '')
      }
      if (invRes.status === 'fulfilled' && Array.isArray(invRes.value.timeline)) {
        setTimeline(invRes.value.timeline)
      }
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [ip])

  // vaul handles click-outside

  async function handleSave() {
    if (!ip) return
    setSaving(true)
    try {
      const res = await fetch(`${BASE}/devices/${encodeURIComponent(ip)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_type: editType || null, notes: editNotes || null }),
      })
      if (res.ok) {
        const updated: DeviceRow = await res.json()
        onUpdated(updated)
        setSaveOk(true)
        setTimeout(() => setSaveOk(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleForget() {
    if (!ip) return
    setForgetting(true)
    try {
      const res = await fetch(`${BASE}/devices/${encodeURIComponent(ip)}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) {
        onForgotten(ip)
      }
    } finally {
      setForgetting(false)
    }
  }

  const port = detail?.current_port_status

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(2px)',
          zIndex: 100,
        }} />
        <Drawer.Content
          ref={panelRef}
          style={{
            position:      'fixed',
            top:           0, right: 0, bottom: 0,
            width:         400,
            background:    'var(--bg-surface)',
            borderLeft:    '1px solid var(--border-bright)',
            display:       'flex',
            flexDirection: 'column',
            zIndex:        101,
            overflow:      'hidden',
            outline:       'none',
            boxShadow:     '-12px 0 40px rgba(0,0,0,0.6)',
          }}
        >
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot online={detail?.is_online ?? false} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
              {displayName(detail?.hostname ?? null, detail?.mac ?? null)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ip}</div>
          </div>
        </div>
        <button onClick={() => onOpenChange(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
          <X size={18} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>Loading...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Device info grid */}
            <section>
              <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                {[
                  ['MAC',        detail?.mac ?? '--'],
                  ['Switch',     detail?.switch_id ?? '--'],
                  ['Port',       detail?.port_id ?? '--'],
                  ['Type',       TYPE_META[detail?.device_type ?? 'unknown']?.label ?? 'Unknown'],
                  ['First Seen', fmtDate(detail?.first_seen ?? null)],
                  ['Last Seen',  fmtDate(detail?.last_seen ?? null)],
                  ...(port ? [
                    ['Speed',    port.speed ? `${port.speed} Mbps` : '--'],
                    ['PoE',      port.poe_watts ? `${port.poe_watts}W` : 'None'],
                  ] : []),
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{k}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{v as string}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* 24h stability */}
            <section>
              <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Stability</h4>
              <StabilityTimeline events={timeline} />
            </section>

            {/* Edit section */}
            <section>
              <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Edit</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>Device type</label>
                  <select
                    value={editType}
                    onChange={e => setEditType(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                      borderRadius: 6,
                      padding: '7px 10px',
                      fontSize: 13,
                      colorScheme: 'dark',
                    }}
                  >
                    {DEVICE_TYPES.map(t => (
                      <option key={t} value={t}>{TYPE_META[t].label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>Notes</label>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    rows={3}
                    placeholder="Add notes about this device..."
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                      borderRadius: 6,
                      padding: '7px 10px',
                      fontSize: 13,
                      resize: 'vertical',
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    padding: '8px 16px',
                    background: saveOk ? 'var(--green)' : 'var(--blue)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: saving ? 'wait' : 'pointer',
                    fontSize: 13,
                    fontWeight: 500,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    opacity: saving ? 0.7 : 1,
                    alignSelf: 'flex-start',
                  }}
                >
                  {saveOk ? <><Check size={14} /> Saved</> : saving ? 'Saving...' : <><Edit2 size={14} /> Save changes</>}
                </button>
              </div>
            </section>

            {/* Forget device */}
            <section style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              {!confirmForget ? (
                <button
                  onClick={() => setConfirmForget(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    background: 'none',
                    border: '1px solid #ef444455',
                    color: '#ef4444',
                    borderRadius: 6,
                    padding: '7px 12px',
                    fontSize: 13,
                    cursor: 'pointer',
                    width: '100%',
                    justifyContent: 'center',
                  }}
                >
                  <Trash2 size={14} /> Forget device
                </button>
              ) : (
                <div style={{
                  background: '#ef444411',
                  border: '1px solid #ef444433',
                  borderRadius: 8,
                  padding: '12px 14px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#ef4444', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    <AlertTriangle size={14} /> Remove this device?
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                    This removes {ip} from the registry. It will reappear automatically if the collector sees it again.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handleForget}
                      disabled={forgetting}
                      style={{
                        flex: 1, padding: '7px', background: '#ef4444', color: '#fff',
                        border: 'none', borderRadius: 6, cursor: forgetting ? 'wait' : 'pointer',
                        fontSize: 13, fontWeight: 500, opacity: forgetting ? 0.7 : 1,
                      }}
                    >
                      {forgetting ? 'Removing...' : 'Yes, forget'}
                    </button>
                    <button
                      onClick={() => setConfirmForget(false)}
                      style={{
                        flex: 1, padding: '7px', background: 'var(--bg-base)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>

          </div>
        )}
      </div>

      {/* Footer — Investigate button */}
      <div style={{
        padding: '14px 20px',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <button
          onClick={() => { if (ip) { navigate(`/network/investigate?ip=${encodeURIComponent(ip)}`); onOpenChange(false) } }}
          style={{
            width: '100%',
            padding: '10px',
            background: '#3b82f6',
            border: '1px solid #3b82f6',
            color: '#fff',
            borderRadius: 5,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            boxShadow: '0 0 12px rgba(59,130,246,0.35)',
          }}
        >
          <ExternalLink size={14} /> Investigate
        </button>
      </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Devices() {
  const navigate = useNavigate()

  const [devices, setDevices]           = useState<DeviceRow[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [lastRefresh, setLastRefresh]   = useState<Date | null>(null)

  const [search, setSearch]             = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort]                 = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({ col: 'last_seen', dir: 'desc' })

  const [selectedIp, setSelectedIp]     = useState<string | null>(null)

  // Inline notes editing: ip → current draft
  const [inlineNotes, setInlineNotes]   = useState<Record<string, string>>({})
  const [editingNotes, setEditingNotes] = useState<string | null>(null) // ip of row being edited

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchDevices = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch(`${BASE}/devices`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<DeviceRow[]>
      })
      .then(data => {
        setDevices(data)
        setLastRefresh(new Date())
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // ── Derived data ───────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return devices.filter(d => {
      if (statusFilter === 'online'  && !d.is_online) return false
      if (statusFilter === 'offline' && d.is_online)  return false
      if (statusFilter === 'unknown' && d.device_type !== null) return false
      if (q) {
        const hay = [d.hostname, d.ip, d.mac, d.switch_id, d.port_id, d.device_type]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [devices, search, statusFilter])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sort.col) {
        case 'hostname':    cmp = displayName(a.hostname, a.mac).localeCompare(displayName(b.hostname, b.mac)); break
        case 'ip':          cmp = a.ip.localeCompare(b.ip); break
        case 'is_online':   cmp = Number(b.is_online) - Number(a.is_online); break
        case 'device_type': cmp = (a.device_type ?? 'unknown').localeCompare(b.device_type ?? 'unknown'); break
        case 'last_seen': {
          const aT = a.last_seen ? new Date(a.last_seen).getTime() : 0
          const bT = b.last_seen ? new Date(b.last_seen).getTime() : 0
          cmp = bT - aT
          break
        }
      }
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sort])

  function toggleSort(col: SortCol) {
    setSort(prev =>
      prev.col === col
        ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: col === 'last_seen' ? 'desc' : 'asc' }
    )
  }

  // ── Callbacks from panel ───────────────────────────────────────────────────

  function handleUpdated(updated: DeviceRow) {
    setDevices(prev => prev.map(d => d.ip === updated.ip ? updated : d))
  }

  function handleForgotten(ip: string) {
    setDevices(prev => prev.filter(d => d.ip !== ip))
    setSelectedIp(null)
  }

  // ── Inline notes handlers ──────────────────────────────────────────────────

  function startEditNotes(d: DeviceRow, e: React.MouseEvent) {
    e.stopPropagation()
    setInlineNotes(prev => ({ ...prev, [d.ip]: d.notes ?? '' }))
    setEditingNotes(d.ip)
  }

  async function commitNotes(ip: string) {
    const notes = inlineNotes[ip] ?? ''
    try {
      const res = await fetch(`${BASE}/devices/${encodeURIComponent(ip)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notes || null }),
      })
      if (res.ok) {
        const updated: DeviceRow = await res.json()
        handleUpdated(updated)
      }
    } catch { /* best-effort */ }
    setEditingNotes(null)
  }

  // ── Counts for filter pills ────────────────────────────────────────────────

  const counts = useMemo(() => ({
    all:     devices.length,
    online:  devices.filter(d => d.is_online).length,
    offline: devices.filter(d => !d.is_online).length,
    unknown: devices.filter(d => d.device_type === null).length,
  }), [devices])

  // ── Render ─────────────────────────────────────────────────────────────────

  const filterPills: { key: StatusFilter; label: string }[] = [
    { key: 'all',     label: `All (${counts.all})` },
    { key: 'online',  label: `Online (${counts.online})` },
    { key: 'offline', label: `Offline (${counts.offline})` },
    { key: 'unknown', label: `Unknown type (${counts.unknown})` },
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Page header */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Devices</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, margin: 0 }}>
            All devices discovered by the network collector
            {lastRefresh && (
              <span style={{ marginLeft: 10 }}>· Updated {ago(lastRefresh.toISOString())}</span>
            )}
          </p>
        </div>
        <button
          onClick={fetchDevices}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
            borderRadius: 7,
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 13,
          }}
        >
          <RefreshCw size={13} style={{ opacity: loading ? 0.4 : 1 }} />
          Refresh
        </button>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200, maxWidth: 360 }}>
          <Search size={14} style={{
            position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-muted)', pointerEvents: 'none',
          }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search hostname, IP, MAC..."
            style={{
              width: '100%',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              borderRadius: 7,
              padding: '8px 12px 8px 32px',
              fontSize: 13,
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 6 }}>
          {/* Export CSV */}
          {sorted.length > 0 && (
            <button
              onClick={() => {
                const header = ['IP', 'Hostname', 'MAC', 'Switch', 'Port', 'Type', 'Online', 'Last Seen', 'Notes']
                const rows = sorted.map(d => [
                  d.ip, d.hostname ?? '', d.mac ?? '', d.switch_id ?? '', d.port_id ?? '',
                  d.device_type ?? 'unknown', d.is_online ? 'Yes' : 'No',
                  d.last_seen ? new Date(d.last_seen).toISOString() : '', `"${(d.notes ?? '').replace(/"/g, '""')}"`,
                ])
                const csv = [header, ...rows].map(r => r.join(',')).join('\n')
                const a = Object.assign(document.createElement('a'), {
                  href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
                  download: `devices_${new Date().toISOString().slice(0, 10)}.csv`,
                })
                a.click()
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'none', border: '1px solid var(--border)',
                color: 'var(--text-muted)', borderRadius: 20,
                padding: '6px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              <Download size={11} /> Export CSV
            </button>
          )}
          {filterPills.map(pill => {
            const active = statusFilter === pill.key
            let borderColor = 'var(--border)'
            let background  = 'var(--bg-surface)'
            let color       = 'var(--text-muted)'
            if (active) {
              if (pill.key === 'online')  { borderColor = '#22c55e'; background = 'rgba(34,197,94,0.12)';   color = '#22c55e' }
              else if (pill.key === 'offline') { borderColor = '#6b7280'; background = 'rgba(107,114,128,0.12)'; color = '#9ca3af' }
              else { borderColor = 'var(--blue)'; background = 'rgba(59,130,246,0.12)'; color = 'var(--blue)' }
            }
            return (
              <button
                key={pill.key}
                onClick={() => setStatusFilter(pill.key)}
                style={{
                  padding: '6px 13px',
                  borderRadius: 20,
                  border: `1px solid ${borderColor}`,
                  background,
                  color,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {pill.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: '#ef444411',
          border: '1px solid #ef444433',
          borderRadius: 8,
          padding: '12px 16px',
          color: '#ef4444',
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <AlertTriangle size={14} /> Failed to load devices: {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && devices.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '80px 32px',
          color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📡</div>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            No devices discovered yet
          </h3>
          <p style={{ fontSize: 13, maxWidth: 380, margin: '0 auto' }}>
            Start the collector inside your network to begin. Devices will appear here as soon as the collector detects them.
          </p>
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && !error && devices.length > 0 && sorted.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-muted)', fontSize: 13 }}>
          No devices match the current filter.
        </div>
      )}

      {/* Table */}
      {(loading || sorted.length > 0) && (
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-base)' }}>
                <th style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', width: 32 }} />
                <SortTh col="hostname"    label="Hostname"   sort={sort} onSort={toggleSort} />
                <SortTh col="ip"          label="IP"         sort={sort} onSort={toggleSort} />
                <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>MAC</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>Switch / Port</th>
                <SortTh col="device_type" label="Type"       sort={sort} onSort={toggleSort} />
                <SortTh col="last_seen"   label="Last Seen"  sort={sort} onSort={toggleSort} />
                <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {loading && devices.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 8 }).map((__, j) => (
                      <td key={j} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{
                          height: 13, borderRadius: 4,
                          background: 'var(--bg-base)',
                          width: j === 0 ? 10 : j === 1 ? '70%' : j === 2 ? '80%' : '60%',
                          animation: 'pulse 1.5s ease-in-out infinite',
                        }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                sorted.map(d => {
                  const isSelected = selectedIp === d.ip
                  const isEditingThisNote = editingNotes === d.ip
                  return (
                    <tr
                      key={d.ip}
                      onClick={() => setSelectedIp(isSelected ? null : d.ip)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(59,130,246,0.07)' : 'transparent',
                        borderLeft: isSelected ? '3px solid var(--blue)' : '3px solid transparent',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => {
                        if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.03)'
                      }}
                      onMouseLeave={e => {
                        if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'
                      }}
                    >
                      {/* Status */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                        <StatusDot online={d.is_online} />
                      </td>

                      {/* Hostname */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            navigate(`/network/investigate?ip=${encodeURIComponent(d.ip)}`)
                          }}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--blue)', fontWeight: 500, fontSize: 14,
                            padding: 0, display: 'flex', alignItems: 'center', gap: 5,
                          }}
                        >
                          {displayName(d.hostname, d.mac)}
                          <ExternalLink size={11} style={{ opacity: 0.6 }} />
                        </button>
                      </td>

                      {/* IP */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 13, color: 'var(--text-muted)' }}>
                        {d.ip}
                      </td>

                      {/* MAC */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                        {d.mac ?? '--'}
                      </td>

                      {/* Switch/Port */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)' }}>
                        {d.switch_id
                          ? `${d.switch_name ?? d.switch_id} / Port ${d.port_id ?? '--'}`
                          : '--'}
                      </td>

                      {/* Type */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                        <TypeChip type={d.device_type} />
                      </td>

                      {/* Last seen */}
                      <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {ago(d.last_seen)}
                      </td>

                      {/* Notes */}
                      <td
                        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', maxWidth: 200 }}
                        onClick={e => e.stopPropagation()}
                      >
                        {isEditingThisNote ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              autoFocus
                              value={inlineNotes[d.ip] ?? ''}
                              onChange={e => setInlineNotes(prev => ({ ...prev, [d.ip]: e.target.value }))}
                              onBlur={() => commitNotes(d.ip)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitNotes(d.ip)
                                if (e.key === 'Escape') setEditingNotes(null)
                              }}
                              style={{
                                flex: 1,
                                background: 'var(--bg-base)',
                                border: '1px solid var(--blue)',
                                color: 'var(--text-primary)',
                                borderRadius: 5,
                                padding: '4px 8px',
                                fontSize: 12,
                                minWidth: 0,
                              }}
                            />
                            <button
                              onMouseDown={() => commitNotes(d.ip)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--green)', padding: 2 }}
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onMouseDown={() => setEditingNotes(null)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={e => startEditNotes(d, e)}
                            title={d.notes ?? 'Click to add notes'}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5,
                              cursor: 'text',
                              color: d.notes ? 'var(--text-muted)' : '#374151',
                              fontSize: 12,
                              maxWidth: 180,
                            }}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                              {d.notes ?? 'Add note...'}
                            </span>
                            <Edit2 size={11} style={{ flexShrink: 0, opacity: 0.5 }} />
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>

          {/* Table footer */}
          {sorted.length > 0 && (
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border)',
              fontSize: 12,
              color: 'var(--text-muted)',
              display: 'flex',
              justifyContent: 'space-between',
            }}>
              <span>{sorted.length} device{sorted.length !== 1 ? 's' : ''}{sorted.length !== devices.length ? ` (filtered from ${devices.length})` : ''}</span>
              <span>{counts.online} online · {counts.offline} offline</span>
            </div>
          )}
        </div>
      )}

      {/* Device drawer */}
      <DevicePanel
        ip={selectedIp}
        open={selectedIp !== null}
        onOpenChange={v => { if (!v) setSelectedIp(null) }}
        onUpdated={handleUpdated}
        onForgotten={handleForgotten}
      />
    </div>
    </div>
  )
}
