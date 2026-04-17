import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Monitor, Server, Printer, Wifi as WifiIcon,
  HelpCircle, ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight,
  ExternalLink, Edit2, Check, X, Trash2, AlertTriangle,
  RefreshCw, Download, Router, Smartphone, Network, Cpu,
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer,
} from 'recharts'
import { Drawer } from 'vaul'
import { TextScramble } from '../../components/TextScramble'
import { getDeviceSoftware, getDiskTrend, type SoftwareRow, type DiskTrendResponse } from '../../lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeviceRow {
  ip:                  string
  mac:                 string | null
  hostname:            string | null
  switch_id:           string | null
  switch_name:         string | null
  port_id:             string | null
  last_seen:           string | null
  first_seen:          string | null
  is_online:           boolean
  device_type:         string | null
  notes:               string | null
  is_wired:            boolean | null
  // NinjaRMM-enriched fields
  ninja_id:            number | null
  os_name:             string | null
  last_logged_in_user: string | null
  serial:              string | null
  ninja_online:        boolean | null
  disk_free_pct:       number | null
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
  // NinjaRMM-enriched fields
  ninja_id:            number | null
  os_name:             string | null
  last_logged_in_user: string | null
  serial:              string | null
  ninja_online:        boolean | null
  disk_free_pct:       number | null
  last_reboot:         string | null
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

interface DeviceGroup {
  key:          string
  hostname:     string | null
  entries:      DeviceRow[]   // sorted by last_seen desc; entries[0] is primary
  isDuplicate:  boolean       // true when same hostname + same MAC vendor → multiple interfaces on one device
  isSharedName: boolean       // true when hostname appears in multiple separate groups (common device name)
}

type SortCol      = 'hostname' | 'ip' | 'last_seen' | 'device_type' | 'is_online'
type StatusFilter = 'all' | 'online' | 'offline' | 'unknown' | 'wired' | 'wireless'
type DeviceType   = 'workstation' | 'desktop' | 'server' | 'printer' | 'ap' | 'gateway' | 'mobile' | 'network_infrastructure' | 'unknown'

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api/network'

const TYPE_META: Record<string, { label: string; Icon: React.ComponentType<{ size?: number }> }> = {
  workstation:            { label: 'Workstation',    Icon: Monitor },
  desktop:                { label: 'Desktop',        Icon: Cpu },
  server:                 { label: 'Server',         Icon: Server },
  printer:                { label: 'Printer',        Icon: Printer },
  ap:                     { label: 'Access Point',   Icon: WifiIcon },
  gateway:                { label: 'Gateway',        Icon: Router },
  mobile:                 { label: 'Mobile',         Icon: Smartphone },
  network_infrastructure: { label: 'Network Device', Icon: Network },
  unknown:                { label: 'Unknown',        Icon: HelpCircle },
}

const DEVICE_TYPES: DeviceType[] = [
  'workstation', 'desktop', 'server', 'printer', 'ap',
  'gateway', 'mobile', 'network_infrastructure', 'unknown',
]

const EVENT_COLORS: Record<string, string> = {
  device_offline:  'var(--red)',
  device_online:   'var(--green)',
  port_error:      'var(--amber)',
  latency_spike:   'var(--amber)',
  traffic_anomaly: 'var(--blue)',
  default:         'var(--text-muted)',
}

// Common/generic device names that many devices share — excluded from duplicate grouping
const GENERIC_HOSTNAMES = new Set([
  'iphone', 'ipad', 'ipad mini', 'ipad pro', 'ipad air',
  'macbook', 'macbook pro', 'macbook air', 'mac mini', 'imac', 'mac pro', 'mac studio',
  'apple tv', 'apple watch', 'watch',
  'android', 'android phone', 'android device',
  'galaxy', 'pixel', 'home',
])

function isGenericHostname(hostname: string | null): boolean {
  if (!hostname) return false
  return GENERIC_HOSTNAMES.has(hostname.trim().toLowerCase())
}

// Returns the first 3 octets of a MAC address (OUI / vendor prefix) as a lowercase hex string
function macVendorPrefix(mac: string | null): string {
  if (!mac) return 'unknown'
  return mac.replace(/[^a-fA-F0-9]/g, '').slice(0, 6).toLowerCase()
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

function InterfacesBadge({ count }: { count: number }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 7px',
      borderRadius: 10,
      fontSize: 11,
      fontWeight: 600,
      background: 'rgba(34,197,94,0.15)',
      border: '1px solid rgba(34,197,94,0.4)',
      color: 'var(--green)',
      lineHeight: 1.4,
      flexShrink: 0,
    }}>
      {count} interfaces
    </span>
  )
}

function CommonNameIcon() {
  return (
    <span
      title="This hostname is shared by many devices and may not be unique."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        color: '#4b5563',
        cursor: 'help',
        flexShrink: 0,
      }}
    >
      <HelpCircle size={12} />
    </span>
  )
}

function ConnectionTag({ wired }: { wired: boolean | null }) {
  const label = wired === true ? 'Wired' : wired === false ? 'Wi-Fi' : 'Unknown'
  const color = wired === true ? 'var(--blue)' : wired === false ? '#a78bfa' : 'var(--text-muted)'
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      borderRadius: 8,
      fontSize: 11,
      fontWeight: 600,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      color,
    }}>
      {label}
    </span>
  )
}

function ConnectionCard({
  entry,
  onInspect,
}: {
  entry: DeviceRow
  onInspect: () => void
}) {
  return (
    <div style={{
      flex: 1,
      background: 'var(--bg-base)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot online={entry.is_online} />
        <ConnectionTag wired={entry.is_wired} />
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{ago(entry.last_seen)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
        {[
          ['IP',         entry.ip],
          ['MAC',        entry.mac ?? '--'],
          ['Switch',     entry.switch_name ?? entry.switch_id ?? '--'],
          ['Port',       entry.port_id ? `Port ${entry.port_id}` : '--'],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 1 }}>{label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</div>
          </div>
        ))}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onInspect() }}
        style={{
          marginTop: 2,
          padding: '5px 10px',
          background: 'none',
          border: '1px solid var(--border)',
          color: 'var(--text-muted)',
          borderRadius: 5,
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          alignSelf: 'flex-start',
        }}
      >
        <ExternalLink size={11} /> Inspect
      </button>
    </div>
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

  // NinjaRMM tabs: 'info' | 'software' | 'disk'
  const [ninjaTab, setNinjaTab]         = useState<'info' | 'software' | 'disk'>('info')
  const [software, setSoftware]         = useState<SoftwareRow[]>([])
  const [swLoading, setSwLoading]       = useState(false)
  const [swQuery, setSwQuery]           = useState('')
  const [diskTrend, setDiskTrend]       = useState<DiskTrendResponse | null>(null)
  const [diskLoading, setDiskLoading]   = useState(false)

  // Load detail + 24h timeline in parallel
  useEffect(() => {
    if (!ip) return
    let cancelled = false
    setLoading(true)
    setDetail(null)
    setTimeline([])
    setConfirmForget(false)
    setNinjaTab('info')
    setSoftware([])
    setSwQuery('')
    setDiskTrend(null)

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

  // Lazy-load software when tab becomes active
  useEffect(() => {
    if (ninjaTab !== 'software' || !detail?.ninja_id) return
    if (software.length > 0) return   // already loaded for this device
    let cancelled = false
    setSwLoading(true)
    getDeviceSoftware(detail.ninja_id)
      .then(data => { if (!cancelled) { setSoftware(data); setSwLoading(false) } })
      .catch(() => { if (!cancelled) setSwLoading(false) })
    return () => { cancelled = true }
  }, [ninjaTab, detail?.ninja_id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load disk trend when tab becomes active
  useEffect(() => {
    if (ninjaTab !== 'disk' || !detail?.ninja_id) return
    if (diskTrend !== null) return   // already loaded for this device
    let cancelled = false
    setDiskLoading(true)
    getDiskTrend(detail.ninja_id, 14)
      .then(data => { if (!cancelled) { setDiskTrend(data); setDiskLoading(false) } })
      .catch(() => { if (!cancelled) setDiskLoading(false) })
    return () => { cancelled = true }
  }, [ninjaTab, detail?.ninja_id])  // eslint-disable-line react-hooks/exhaustive-deps

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
                  ...(detail?.os_name ? [
                    ['OS', detail.os_name],
                  ] : []),
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{k}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{v as string}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* NinjaRMM section — only shown when ninja_id is set */}
            {detail?.ninja_id && (
              <section>
                <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>NinjaRMM</h4>

                {/* Tab bar */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
                  {(['info', 'software', 'disk'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setNinjaTab(tab)}
                      style={{
                        padding: '5px 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: ninjaTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                        borderBottom: ninjaTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                        marginBottom: -1,
                        textTransform: 'capitalize',
                      }}
                    >
                      {tab === 'disk' ? 'Disk Trend' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                  ))}
                </div>

                {/* Info tab */}
                {ninjaTab === 'info' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                    {[
                      ['User',       detail.last_logged_in_user ?? '--'],
                      ['Serial',     detail.serial               ?? '--'],
                      ['Ninja Online', detail.ninja_online === true ? 'Yes' : detail.ninja_online === false ? 'No' : '--'],
                      ['Disk Free',  detail.disk_free_pct != null ? `${detail.disk_free_pct.toFixed(1)}%` : '--'],
                      ['Last Reboot', detail.last_reboot ? new Date(detail.last_reboot).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '--'],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{k}</div>
                        <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{v as string}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Software tab */}
                {ninjaTab === 'software' && (
                  <div>
                    <input
                      type="text"
                      placeholder="Filter by name…"
                      value={swQuery}
                      onChange={e => setSwQuery(e.target.value)}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                        borderRadius: 6, padding: '6px 10px',
                        fontSize: 12, marginBottom: 10,
                      }}
                    />
                    {swLoading ? (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '20px 0' }}>Loading…</p>
                    ) : software.length === 0 ? (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '20px 0' }}>No software data available.</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 300, overflowY: 'auto' }}>
                        {software
                          .filter(s => !swQuery || s.name.toLowerCase().includes(swQuery.toLowerCase()))
                          .map(s => (
                            <div key={s.id} style={{
                              padding: '6px 8px',
                              borderRadius: 5,
                              background: 'var(--bg-base)',
                              border: '1px solid var(--border-dim)',
                            }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{s.name}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                                {[s.version, s.publisher].filter(Boolean).join(' · ') || '--'}
                              </div>
                            </div>
                          ))
                        }
                      </div>
                    )}
                  </div>
                )}

                {/* Disk trend tab */}
                {ninjaTab === 'disk' && (
                  <div>
                    {diskLoading ? (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '20px 0' }}>Loading…</p>
                    ) : !diskTrend || diskTrend.history.length === 0 ? (
                      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '20px 0' }}>No disk history yet.</p>
                    ) : (
                      <div>
                        <ResponsiveContainer width="100%" height={120}>
                          <AreaChart data={diskTrend.history} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                            <defs>
                              <linearGradient id="diskGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%"  stopColor="var(--accent)" stopOpacity={0.35} />
                                <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.03} />
                              </linearGradient>
                            </defs>
                            <XAxis
                              dataKey="recorded_at"
                              tickFormatter={v => new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                              tickLine={false}
                              axisLine={false}
                              interval="preserveStartEnd"
                            />
                            <YAxis
                              domain={[0, 100]}
                              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                              tickLine={false}
                              axisLine={false}
                              tickFormatter={v => `${v}%`}
                            />
                            <ReTooltip
                              contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 5, fontSize: 12 }}
                              labelFormatter={v => new Date(v as string).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                              formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Disk Free']}
                            />
                            <Area
                              type="monotone"
                              dataKey="disk_free_pct"
                              stroke="var(--accent)"
                              strokeWidth={2}
                              fill="url(#diskGrad)"
                              dot={false}
                              isAnimationActive={false}
                            />
                          </AreaChart>
                        </ResponsiveContainer>

                        {/* Fill rate annotation */}
                        <div style={{ marginTop: 10, fontSize: 12 }}>
                          {diskTrend.fill_rate_pct_per_day === null ? null
                            : diskTrend.fill_rate_pct_per_day >= 0 ? (
                              <span style={{ color: '#22c55e', fontWeight: 600 }}>Stable (disk is not filling)</span>
                            ) : (
                              <span style={{
                                fontWeight: 600,
                                color: diskTrend.days_until_full != null && diskTrend.days_until_full < 7
                                  ? '#ef4444'
                                  : diskTrend.days_until_full != null && diskTrend.days_until_full < 30
                                  ? '#eab308'
                                  : 'var(--text-muted)',
                              }}>
                                Filling at ~{Math.abs(diskTrend.fill_rate_pct_per_day).toFixed(2)}% per day
                                {diskTrend.days_until_full != null
                                  ? ` · Full in ~${diskTrend.days_until_full} days`
                                  : ''}
                              </span>
                            )
                          }
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

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
      if (statusFilter === 'online'    && !d.is_online) return false
      if (statusFilter === 'offline'   && d.is_online)  return false
      if (statusFilter === 'unknown'   && d.device_type !== null) return false
      if (statusFilter === 'wired'     && d.is_wired !== true)  return false
      if (statusFilter === 'wireless'  && d.is_wired !== false) return false
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

  // Group sorted rows into physical devices.
  //
  // Priority order for the group key:
  //   1. No/generic hostname → unique row per IP, never grouped.
  //   2. Both rows share the same non-null last_logged_in_user (NinjaRMM) →
  //      group by hostname:user — definite same physical device, multiple interfaces.
  //   3. One or both rows have a non-null last_logged_in_user that differs →
  //      force unique key per IP — different physical devices sharing a hostname.
  //   4. Both rows have null last_logged_in_user → fall back to hostname:macVendor
  //      (original behaviour).
  //
  // Because we only know another row's user after we've seen it, we do two passes:
  //   Pass 1 — bucket rows by hostname to find which user-values appear per hostname.
  //   Pass 2 — assign the final group key using the rules above.
  const grouped = useMemo<DeviceGroup[]>(() => {
    // Pass 1: collect all distinct non-null users per normalised hostname
    const usersByHostname = new Map<string, Set<string>>()
    for (const d of sorted) {
      const h = d.hostname?.trim().toLowerCase()
      if (!h || isGenericHostname(d.hostname)) continue
      if (d.last_logged_in_user) {
        if (!usersByHostname.has(h)) usersByHostname.set(h, new Set())
        usersByHostname.get(h)!.add(d.last_logged_in_user.toLowerCase())
      }
    }

    // Pass 2: assign group keys
    const map = new Map<string, DeviceRow[]>()
    for (const d of sorted) {
      const h = d.hostname?.trim().toLowerCase()
      let key: string
      if (!h || isGenericHostname(d.hostname)) {
        // No hostname or generic name → unique row per IP, no grouping
        key = `__ip__${d.ip}`
      } else {
        const usersForHostname = usersByHostname.get(h)
        const thisUser = d.last_logged_in_user?.toLowerCase() ?? null

        if (usersForHostname && usersForHostname.size > 1) {
          // Multiple distinct users share this hostname → different physical devices.
          // Each user gets its own group; rows with no user get a unique per-IP key.
          key = thisUser ? `${h}:user:${thisUser}` : `__ip__${d.ip}`
        } else if (thisUser) {
          // Only one user value seen for this hostname (or this is the only row with
          // a user). Group by hostname:user — definite same physical device.
          key = `${h}:user:${thisUser}`
        } else {
          // No NinjaRMM user data → original MAC-vendor grouping
          key = `${h}:${macVendorPrefix(d.mac)}`
        }
      }
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(d)
    }

    // Count how many groups share the same display hostname (for "common name" badge)
    const hostnameGroupCount = new Map<string, number>()
    for (const entries of map.values()) {
      const h = entries[0].hostname?.trim().toLowerCase()
      if (h) hostnameGroupCount.set(h, (hostnameGroupCount.get(h) ?? 0) + 1)
    }

    return Array.from(map.entries()).map(([_key, entries]) => {
      const h = entries[0].hostname?.trim().toLowerCase()
      return {
        key: _key,
        hostname: entries[0].hostname,
        entries,
        isDuplicate:  entries.length > 1,
        isSharedName: h ? (hostnameGroupCount.get(h) ?? 0) > 1 : false,
      }
    })
  }, [sorted])

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
    all:      devices.length,
    online:   devices.filter(d => d.is_online).length,
    offline:  devices.filter(d => !d.is_online).length,
    unknown:  devices.filter(d => d.device_type === null).length,
    wired:    devices.filter(d => d.is_wired === true).length,
    wireless: devices.filter(d => d.is_wired === false).length,
  }), [devices])

  // ── Render ─────────────────────────────────────────────────────────────────

  const filterPills: { key: StatusFilter; label: string }[] = [
    { key: 'all',      label: `All (${counts.all})` },
    { key: 'online',   label: `Online (${counts.online})` },
    { key: 'offline',  label: `Offline (${counts.offline})` },
    { key: 'wired',    label: `Wired (${counts.wired})` },
    { key: 'wireless', label: `Wi-Fi (${counts.wireless})` },
    { key: 'unknown',  label: `Unknown type (${counts.unknown})` },
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
      {!loading && !error && devices.length > 0 && grouped.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-muted)', fontSize: 13 }}>
          No devices match the current filter.
        </div>
      )}

      {/* Table */}
      {(loading || grouped.length > 0) && (
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
                grouped.map(group => {
                  const primary         = group.entries[0]
                  const anyOnline       = group.entries.some(e => e.is_online)
                  const isExpanded      = expandedGroups.has(group.key)
                  const isSelected      = !group.isDuplicate && selectedIp === primary.ip
                  const isEditingThisNote = !group.isDuplicate && editingNotes === primary.ip

                  return (
                    <Fragment key={group.key}>
                      {/* Summary row */}
                      <tr
                        onClick={() => {
                          if (group.isDuplicate) toggleGroup(group.key)
                          else setSelectedIp(isSelected ? null : primary.ip)
                        }}
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
                          {group.isDuplicate ? (
                            <span style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
                              {isExpanded
                                ? <ChevronDown size={14} />
                                : <ChevronRight size={14} />}
                            </span>
                          ) : (
                            <StatusDot online={anyOnline} />
                          )}
                        </td>

                        {/* Hostname */}
                        <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {group.isDuplicate ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <StatusDot online={anyOnline} />
                                <span style={{ fontWeight: 500, fontSize: 14, color: 'var(--text-primary)' }}>
                                  <TextScramble text={displayName(group.hostname, primary.mac)} />
                                </span>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <button
                                    onClick={e => {
                                      e.stopPropagation()
                                      navigate(`/network/investigate?ip=${encodeURIComponent(primary.ip)}`)
                                    }}
                                    style={{
                                      background: 'none', border: 'none', cursor: 'pointer',
                                      color: 'var(--blue)', fontWeight: 500, fontSize: 14,
                                      padding: 0, display: 'flex', alignItems: 'center', gap: 5,
                                    }}
                                  >
                                    <TextScramble text={displayName(primary.hostname, primary.mac)} />
                                    <ExternalLink size={11} style={{ opacity: 0.6 }} />
                                  </button>
                                  {primary.disk_free_pct !== null && primary.disk_free_pct < 15 && (
                                    <span style={{
                                      fontSize: 10, fontWeight: 600,
                                      background: 'rgba(239,68,68,0.15)',
                                      color: '#ef4444',
                                      border: '1px solid rgba(239,68,68,0.35)',
                                      borderRadius: 4,
                                      padding: '1px 5px',
                                      whiteSpace: 'nowrap',
                                    }}>
                                      Low disk
                                    </span>
                                  )}
                                </div>
                                {primary.last_logged_in_user && (
                                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    {primary.last_logged_in_user}
                                  </span>
                                )}
                              </div>
                            )}
                            {group.isDuplicate && <InterfacesBadge count={group.entries.length} />}
                            {!group.isDuplicate && group.isSharedName && <CommonNameIcon />}
                          </div>
                        </td>

                        {/* IP */}
                        <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 13, color: 'var(--text-muted)' }}>
                          {group.isDuplicate
                            ? <span style={{ fontSize: 12 }}>multiple</span>
                            : <TextScramble text={primary.ip} />}
                        </td>

                        {/* MAC */}
                        <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                          {group.isDuplicate ? '--' : (primary.mac ?? '--')}
                        </td>

                        {/* Switch/Port */}
                        <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)' }}>
                          {group.isDuplicate
                            ? '--'
                            : primary.switch_id
                              ? `${primary.switch_name ?? primary.switch_id} / Port ${primary.port_id ?? '--'}`
                              : '--'}
                        </td>

                        {/* Type */}
                        <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                          <TypeChip type={primary.device_type} />
                        </td>

                        {/* Last seen */}
                        <td style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {ago(primary.last_seen)}
                        </td>

                        {/* Notes */}
                        <td
                          style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', maxWidth: 200 }}
                          onClick={e => e.stopPropagation()}
                        >
                          {group.isDuplicate ? (
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>--</span>
                          ) : isEditingThisNote ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <input
                                autoFocus
                                value={inlineNotes[primary.ip] ?? ''}
                                onChange={e => setInlineNotes(prev => ({ ...prev, [primary.ip]: e.target.value }))}
                                onBlur={() => commitNotes(primary.ip)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') commitNotes(primary.ip)
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
                                onMouseDown={() => commitNotes(primary.ip)}
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
                              onClick={e => startEditNotes(primary, e)}
                              title={primary.notes ?? 'Click to add notes'}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                cursor: 'text',
                                color: primary.notes ? 'var(--text-muted)' : '#374151',
                                fontSize: 12,
                                maxWidth: 180,
                              }}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                {primary.notes ?? 'Add note...'}
                              </span>
                              <Edit2 size={11} style={{ flexShrink: 0, opacity: 0.5 }} />
                            </div>
                          )}
                        </td>
                      </tr>

                      {/* Expanded connections panel */}
                      {group.isDuplicate && isExpanded && (
                        <tr>
                          <td colSpan={8} style={{
                            padding: '0 14px 14px 40px',
                            borderBottom: '1px solid var(--border)',
                            background: 'rgba(34,197,94,0.03)',
                          }}>
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                              {group.entries.map(entry => (
                                <ConnectionCard
                                  key={entry.ip}
                                  entry={entry}
                                  onInspect={() => setSelectedIp(entry.ip)}
                                />
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>

          {/* Table footer */}
          {grouped.length > 0 && (
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border)',
              fontSize: 12,
              color: 'var(--text-muted)',
              display: 'flex',
              justifyContent: 'space-between',
            }}>
              <span>
                {grouped.length} device{grouped.length !== 1 ? 's' : ''}
                {sorted.length !== grouped.length && ` · ${sorted.length} connections`}
                {sorted.length !== devices.length ? ` (filtered from ${devices.length})` : ''}
              </span>
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
