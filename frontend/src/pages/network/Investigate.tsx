import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Search, Activity, ExternalLink, Download,
  ChevronDown, ChevronUp, Edit2, Check, X,
  Server, Monitor, Plug, Router, HardDrive, Wifi as WifiIcon,
} from 'lucide-react'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, Cell,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeviceRow {
  ip:          string
  mac:         string | null
  hostname:    string | null
  switch_id:   string | null
  port_id:     string | null
  is_online:   boolean
  device_type: string | null
  last_seen:   string | null
  notes:       string | null
}

interface TimelineEvent {
  time:        string
  event_type:  string
  severity:    string
  description: string
}

interface InvestigateMetrics {
  port_rx_errors:              number
  port_tx_errors:              number
  port_rx_dropped:             number
  port_tx_dropped:             number
  port_rx_frags:               number
  error_rate_pct:              number
  error_timeline_profile:      string
  error_windows_with_errors:   number
  peer_avg_error_rate:         number | null
  peer_comparison_result:      string
  avg_packet_loss_gateway_pct: number
  avg_packet_loss_wan_pct:     number
  avg_rtt_gateway_ms:          number | null
  bytes_sent:                  number
  bytes_received:              number
  top_destinations: Array<{ dst_ip: string | null; protocol_name: string; bytes: number; packets: number }>
  raw_port_metrics: Array<{
    timestamp:     string
    rx_errors:     number
    rx_dropped:    number
    rx_frags:      number
    rx_bytes:      number
    tx_bytes:      number
    error_rate_pct: number
  }>
}

interface Hypothesis {
  likely_cause:       string
  confidence:         'high' | 'medium' | 'low'
  evidence:           string[]
  recommended_action: string
}

interface GlobalIncident {
  id:                 string
  started_at:         string
  resolved_at:        string | null
  severity:           string
  title:              string
  root_cause:         string | null
  affected_component: string | null
}

interface InvestigateResponse {
  device:           Record<string, unknown> | null
  timeline:         TimelineEvent[]
  metrics:          InvestigateMetrics
  hypothesis:       Hypothesis
  global_incidents: GlobalIncident[]
  device_incidents: IncidentRecord[]
}

interface ErrorBucket   { time: string; rx_errors: number; tx_errors: number }
interface LatencyBucket { time: string; avg_rtt: number | null }

interface RawFlow {
  src_ip:    string
  dst_ip:    string
  dst_port:  number | null
  protocol:  number | null
  direction: string | null
  bytes:     number
  packets:   number
}

interface IncidentRecord {
  id:               string
  started_at:       string
  resolved_at:      string | null
  severity:         string
  category:         string
  title:            string
  root_cause:       string | null
  resolution_notes: string | null
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
  port_errors_24h:        ErrorBucket[]
  latency_to_gateway_24h: LatencyBucket[]
  incidents:              IncidentRecord[]
  flows_last_hour:        Record<string, unknown>[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CAUSE_LABELS: Record<string, string> = {
  cable_or_nic:         'Cable or NIC Issue',
  wan_issue:            'WAN / ISP Issue',
  global_wan_incident:  'No device-specific issues — global WAN outage active',
  firewall_drop: 'Firewall Blocking Traffic',
  server_side:   'Remote Server Issue',
  wifi_signal:   'Weak WiFi Signal',
  healthy:       'No Issues Detected',
  unknown:       'Cause Unclear',
}

const SEV_COLORS: Record<string, string> = {
  critical: '#ef4444',
  warning:  '#eab308',
  info:     '#3b82f6',
  ok:       '#22c55e',
}

const DEST_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#06b6d4']

const PORT_NAMES: Record<number, string> = {
  53: 'DNS', 80: 'HTTP', 443: 'HTTPS', 445: 'SMB', 3389: 'RDP',
  22: 'SSH', 25: 'SMTP', 587: 'SMTP', 3306: 'MySQL', 1433: 'MSSQL',
  5432: 'PG', 3478: 'STUN', 8080: 'HTTP', 8443: 'HTTPS',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`
  return `${n} B`
}

function toLocalInput(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.round(diff / 60)} min ago`
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`
  return `${Math.round(diff / 86400)} d ago`
}

function resolveProto(protocol: number | null, dstPort: number | null): string {
  if (protocol === 1)  return 'ICMP'
  if (dstPort && PORT_NAMES[dstPort]) return PORT_NAMES[dstPort]
  if (protocol === 6)  return dstPort ? `TCP/${dstPort}` : 'TCP'
  if (protocol === 17) return dstPort ? `UDP/${dstPort}` : 'UDP'
  return `proto${protocol ?? '?'}`
}

function diagnosisColor(cause: string, conf: string): string {
  if (cause === 'healthy' || cause === 'global_wan_incident') return '#22c55e'
  if (cause === 'unknown') return '#6b7280'
  return conf === 'high' ? '#ef4444' : '#eab308'
}

function exportFlowsCsv(flows: RawFlow[], ip: string) {
  const header = ['Source', 'Destination', 'Protocol', 'Bytes', 'Packets', 'Direction']
  const rows   = flows.map(f => [
    f.src_ip, f.dst_ip,
    resolveProto(f.protocol, f.dst_port),
    f.bytes, f.packets, f.direction ?? '—',
  ])
  const csv  = [header, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = `flows_${ip}_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Shared ────────────────────────────────────────────────────────────────────

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
      textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 12px',
    }}>
      {children}
    </p>
  )
}

function DeviceTypeIcon({ type }: { type: string | null | undefined }) {
  const t = (type ?? '').toLowerCase()
  if (t === 'server')      return <Server size={16} />
  if (t === 'workstation') return <Monitor size={16} />
  if (t === 'ap')          return <WifiIcon size={16} />
  if (t === 'router')      return <Router size={16} />
  if (t === 'nas')         return <HardDrive size={16} />
  return <Plug size={16} />
}

// ── Scenario Cards ────────────────────────────────────────────────────────────

const SCENARIOS = [
  { icon: '🎤', title: "User can't be heard on call",    desc: 'Check port errors, gateway latency, and VoIP traffic during the call', action: 'investigate' },
  { icon: '🌐', title: 'Internet slow for everyone',      desc: 'Check WAN packet loss and top bandwidth consumers',                    action: 'traffic'     },
  { icon: '🔌', title: 'Device keeps disconnecting',      desc: 'Check port error history and device online/offline timeline',          action: 'investigate' },
  { icon: '🖥️', title: "Can't reach internal server",    desc: 'Check latency to server IP and firewall drops',                        action: 'investigate' },
  { icon: '📈', title: 'Network was slow this morning',   desc: 'Check latency history and incidents from that time',                   action: 'latency'     },
  { icon: '❓', title: 'New device not getting internet', desc: 'Check if device appears in registry and has valid IP',                 action: 'devices'     },
] as const

function ScenarioCards({ onFocusSearch }: { onFocusSearch: () => void }) {
  const navigate = useNavigate()
  return (
    <div>
      <p style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, marginBottom: 20 }}>
        Common Scenarios — select one or enter an IP address above
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {SCENARIOS.map((s, i) => (
          <div key={i} className="card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22 }}>{s.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-head)', lineHeight: 1.3 }}>{s.title}</span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0, lineHeight: 1.5 }}>{s.desc}</p>
            <button
              onClick={() => {
                if (s.action === 'investigate') onFocusSearch()
                else if (s.action === 'traffic') navigate('/network/traffic')
                else if (s.action === 'latency') navigate('/network/latency')
                else navigate('/network/devices')
              }}
              style={{
                alignSelf: 'flex-start', padding: '5px 12px', fontSize: 11, fontWeight: 600,
                borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-bright)',
                background: 'var(--accent-dim)', color: 'var(--accent)', cursor: 'pointer', marginTop: 2,
              }}
            >
              {s.action === 'investigate' ? 'Start Investigation'
               : s.action === 'traffic'  ? 'Open Traffic View'
               : s.action === 'latency'  ? 'Open Latency'
               :                           'Check Devices'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Device Panel ──────────────────────────────────────────────────────────────

function DevicePanel({ ip, inv, detail }: { ip: string; inv: InvestigateResponse; detail: DeviceDetail | null }) {
  const dev      = inv.device ?? {}
  const hostname = (dev.hostname   as string | null) ?? detail?.hostname  ?? ip
  const mac      = (dev.mac        as string | null) ?? detail?.mac
  const dtype    = (dev.device_type as string | null) ?? detail?.device_type
  const switchId = (dev.switch_id  as string | null) ?? detail?.switch_id
  const portId   = (dev.port_id    as string | null) ?? detail?.port_id
  const lastSeen = (dev.last_seen  as string | null) ?? detail?.last_seen
  const isOnline = (dev.is_online  as boolean | undefined) ?? detail?.is_online ?? false

  const [notes, setNotes]         = useState(detail?.notes ?? '')
  const [editingNotes, setEditing] = useState(false)
  const [notesSaved, setSaved]     = useState(false)

  useEffect(() => { setNotes(detail?.notes ?? '') }, [detail?.notes])

  async function saveNotes() {
    await fetch(`/api/network/devices/${ip}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
    setEditing(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const statusColor = isOnline ? '#22c55e' : '#ef4444'

  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <SectionHead>Device</SectionHead>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        {/* Icon + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 200px' }}>
          <div style={{
            width: 44, height: 44, borderRadius: 'var(--radius)',
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0,
          }}>
            <DeviceTypeIcon type={dtype} />
          </div>
          <div>
            <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-head)', margin: '0 0 2px', lineHeight: 1.2 }}>{hostname}</p>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'monospace', margin: 0 }}>{ip}</p>
          </div>
        </div>

        {/* Details */}
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', flex: '2 1 300px', alignItems: 'flex-start' }}>
          {mac && (
            <div>
              <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 2px' }}>MAC</p>
              <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text)', margin: 0 }}>{mac}</p>
            </div>
          )}
          {(switchId || portId) && (
            <div>
              <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 4px' }}>Port</p>
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'var(--accent)',
                background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
                borderRadius: 4, padding: '2px 8px',
              }}>
                {switchId}{portId ? ` / ${portId}` : ''}
              </span>
            </div>
          )}
          <div>
            <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 4px' }}>Status</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, boxShadow: `0 0 5px ${statusColor}` }} />
              <span style={{ fontSize: 12, color: statusColor, fontWeight: 600 }}>
                {isOnline ? 'Online' : 'Offline'}
              </span>
              {lastSeen && (
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>— {relTime(lastSeen)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Notes */}
        <div style={{ width: '100%', marginTop: 8, borderTop: '1px solid var(--border-dim)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: 0 }}>Notes</p>
            {!editingNotes ? (
              <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 0, display: 'flex' }}>
                <Edit2 size={11} />
              </button>
            ) : (
              <>
                <button onClick={saveNotes} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#22c55e', padding: 0, display: 'flex' }}><Check size={13} /></button>
                <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 0, display: 'flex' }}><X size={13} /></button>
              </>
            )}
            {notesSaved && <span style={{ fontSize: 10, color: '#22c55e' }}>Saved</span>}
          </div>
          {editingNotes ? (
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={saveNotes}
              autoFocus
              rows={2}
              style={{
                width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border-bright)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 12,
                padding: '6px 10px', outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
          ) : (
            <p
              onClick={() => setEditing(true)}
              style={{ fontSize: 12, color: notes ? 'var(--text)' : 'var(--text-dim)', margin: 0, fontStyle: notes ? 'normal' : 'italic', cursor: 'pointer' }}
            >
              {notes || 'Click to add notes…'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Why-we-think-this explanations per cause ──────────────────────────────────

const CAUSE_EXPLANATIONS: Record<string, string[]> = {
  cable_or_nic: [
    'RX errors accumulate when frames arrive corrupted — the most common cause is a damaged or loose Ethernet cable.',
    'A failing NIC will produce similar error patterns regardless of the cable.',
    'TX errors are rare with modern switches; if both RX and TX are elevated simultaneously, suspect the NIC rather than the cable.',
    'Replacing the patch cable is the quickest first step as it requires no downtime.',
  ],
  wan_issue: [
    'Packet loss on the WAN target (8.8.8.8 / 1.1.1.1) while the gateway remains reachable points to the ISP link, not the LAN.',
    'Fluctuating RTT to external addresses with stable internal latency confirms the issue is upstream.',
    'Check the router WAN interface for PPP re-connects or DHCP lease renewals in the provider logs.',
  ],
  firewall_drop: [
    'High packet loss to a specific destination while other targets are healthy usually means a firewall ACL or security policy is silently dropping packets.',
    'Look for matching DENY entries in the pfSense filter log for the source IP and destination port.',
    'Common triggers: geo-blocking, IDS/IPS signature match, or a new firewall rule pushed overnight.',
  ],
  server_side: [
    'All local paths are healthy (low gateway loss, no port errors) but traffic to a specific remote server shows loss.',
    'This pattern typically means the remote endpoint is overloaded, rate-limiting, or experiencing its own network issues.',
    'Verify by testing from a different network — if the same loss is observed, the problem is at the server or its upstream provider.',
  ],
  wifi_signal: [
    'Wireless clients can show elevated packet loss or latency even when the AP is functioning correctly, due to RF interference or distance.',
    'Check the associated AP for low RSSI or high retry rates in UniFi.',
    'Switching the client to 5 GHz or relocating it closer to the AP typically resolves signal-related issues.',
  ],
  healthy: [
    'No elevated error rates, packet loss, or latency spikes were detected during the selected time window.',
    'If the user is reporting a problem, consider a longer time window or check application-layer logs.',
  ],
  unknown: [
    'Not enough data was collected during the selected window to form a confident diagnosis.',
    'Widen the time window or wait for additional monitoring cycles to accumulate data.',
  ],
}

function WhyWeThink({ cause }: { cause: string }) {
  const [open, setOpen] = useState(false)
  const points = CAUSE_EXPLANATIONS[cause]
  if (!points || points.length === 0) return null

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: 0, color: 'var(--text-dim)',
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
        }}
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        Why we think this
      </button>
      {open && (
        <div style={{ marginTop: 8, paddingLeft: 4 }}>
          {points.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.5, flexShrink: 0 }}>–</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>{p}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Port Error Detail (inside Diagnosis) ─────────────────────────────────────

const TIMELINE_LABELS: Record<string, { text: string; color: string }> = {
  sustained:    { text: 'Sustained (6+ windows)',      color: '#ef4444' },
  single_spike: { text: 'Single spike (1-2 windows)',  color: '#eab308' },
  normal:       { text: 'No pattern / normal',         color: '#22c55e' },
}

const PEER_LABELS: Record<string, { text: string; color: string }> = {
  highly_elevated: { text: '>10× peer average',        color: '#ef4444' },
  elevated:        { text: '2-10× peer average',       color: '#eab308' },
  normal:          { text: 'Similar to peers',         color: '#22c55e' },
  no_peer_data:    { text: 'No peer data',             color: '#6b7280' },
}

function PortErrorDetail({ metrics }: { metrics: InvestigateMetrics }) {
  const hasErrors = metrics.port_rx_errors > 0 || metrics.port_rx_dropped > 0 || metrics.port_rx_frags > 0
  if (!hasErrors && metrics.error_rate_pct < 0.001) return null

  const timeline = TIMELINE_LABELS[metrics.error_timeline_profile] ?? TIMELINE_LABELS.normal
  const peer     = PEER_LABELS[metrics.peer_comparison_result]      ?? PEER_LABELS.no_peer_data
  const rateColor = metrics.error_rate_pct > 0.1 ? '#ef4444' : metrics.error_rate_pct > 0.001 ? '#eab308' : '#22c55e'

  return (
    <div style={{
      margin: '0 0 14px',
      background: 'var(--bg-raised)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '12px 14px',
    }}>
      <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 10px' }}>
        Port Error Detail
      </p>

      {/* Error rate */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border-dim)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Error rate</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: rateColor, fontFamily: 'monospace' }}>
          {metrics.error_rate_pct.toFixed(4)}%
        </span>
      </div>

      {/* Error type breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 10 }}>
        {[
          { label: 'RX Errors',   value: metrics.port_rx_errors,  color: '#ef4444' },
          { label: 'RX Dropped',  value: metrics.port_rx_dropped, color: '#f97316' },
          { label: 'RX Frags',    value: metrics.port_rx_frags,   color: '#eab308' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign: 'center', padding: '6px 4px', background: 'var(--bg-surface)', borderRadius: 4, border: '1px solid var(--border-dim)' }}>
            <p style={{ fontSize: 9, color: 'var(--text-dim)', margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>{label}</p>
            <p style={{ fontSize: 14, fontWeight: 700, color: value > 0 ? color : 'var(--text-dim)', margin: 0 }}>{value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Timeline profile */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Timeline profile</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: timeline.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: timeline.color, fontWeight: 600 }}>{timeline.text}</span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            ({metrics.error_windows_with_errors} of {Math.min(12, Math.max(metrics.error_windows_with_errors, 1))} windows)
          </span>
        </div>
      </div>

      {/* Peer comparison */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Peer comparison</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: peer.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: peer.color, fontWeight: 600 }}>{peer.text}</span>
          {metrics.peer_avg_error_rate !== null && metrics.peer_avg_error_rate !== undefined && (
            <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'monospace' }}>
              (peer avg: {metrics.peer_avg_error_rate.toFixed(4)}%)
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Global Outage Banner ──────────────────────────────────────────────────────

function GlobalOutageBanner({ incidents }: { incidents: GlobalIncident[] }) {
  if (incidents.length === 0) return null
  const open  = incidents.filter(i => !i.resolved_at)
  const color = open.length > 0 ? '#ef4444' : '#eab308'
  const bg     = open.length > 0 ? '#ef444412' : '#eab30812'

  return (
    <div style={{
      background: bg, border: `1px solid ${color}44`,
      borderLeft: `4px solid ${color}`, borderRadius: 'var(--radius)',
      padding: '12px 16px',
    }}>
      <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color, margin: '0 0 8px' }}>
        {open.length > 0 ? 'Active Global Outages During This Window' : 'Global Outages During This Window (Resolved)'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {incidents.map(inc => {
          const sev   = SEV_COLORS[inc.severity] ?? '#6b7280'
          const start = new Date(inc.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          const resolvedText = inc.resolved_at
            ? ` · Resolved ${new Date(inc.resolved_at).toLocaleString([], { hour: '2-digit', minute: '2-digit' })}`
            : ' · Still open'
          return (
            <div key={inc.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: sev, border: `1px solid ${sev}44`, borderRadius: 4, padding: '1px 5px', flexShrink: 0, marginTop: 1 }}>
                {inc.severity}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{inc.title}</span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8 }}>Started {start}{resolvedText}</span>
              </div>
            </div>
          )
        })}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '8px 0 0', fontStyle: 'italic' }}>
        These are network-wide events — not specific to this device.
      </p>
    </div>
  )
}

// ── Diagnosis Panel ───────────────────────────────────────────────────────────

function DiagnosisPanel({ hypothesis, metrics, globalIncidents }: {
  hypothesis:      Hypothesis
  metrics:         InvestigateMetrics
  globalIncidents: GlobalIncident[]
}) {
  // Backend sets likely_cause='global_wan_incident' when WAN loss coincides with an
  // active global incident. Also handle the legacy frontend-only path as a fallback.
  const isWanCausedByGlobal = hypothesis.likely_cause === 'global_wan_incident'
    || (hypothesis.likely_cause === 'wan_issue' && globalIncidents.length > 0)
  const effectiveCause      = isWanCausedByGlobal ? 'global_wan_incident' : hypothesis.likely_cause
  const effectiveLabel      = isWanCausedByGlobal
    ? 'No device-specific issues — global WAN outage active'
    : (CAUSE_LABELS[hypothesis.likely_cause] ?? hypothesis.likely_cause)

  const color   = diagnosisColor(effectiveCause, hypothesis.confidence)
  const confBg  = { high: '#ef444422', medium: '#eab30822', low: '#6b728022' }[hypothesis.confidence]
  const confClr = { high: '#ef4444',   medium: '#eab308',   low: '#9ca3af'  }[hypothesis.confidence]

  return (
    <div className="card" style={{ padding: '16px 20px', borderLeft: `4px solid ${color}`, boxShadow: `0 0 20px ${color}18` }}>
      <SectionHead>Device Diagnosis</SectionHead>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 22, fontWeight: 800, color, margin: 0, flex: 1 }}>{effectiveLabel}</p>
        {!isWanCausedByGlobal && (
          <span style={{
            background: confBg, color: confClr, border: `1px solid ${confClr}55`,
            borderRadius: 100, padding: '3px 12px',
            fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', flexShrink: 0,
          }}>
            {hypothesis.confidence} confidence
          </span>
        )}
      </div>

      {isWanCausedByGlobal ? (
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 14px', lineHeight: 1.6 }}>
          WAN/ISP packet loss was detected during this window, but a global outage was active at the same time.
          The connectivity issue is network-wide — not caused by this device. See the global outage banner above.
        </p>
      ) : (
        <>
          {hypothesis.evidence.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 8px' }}>Evidence</p>
              {hypothesis.evidence.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <span style={{ color, fontSize: 14, lineHeight: 1.5, flexShrink: 0 }}>•</span>
                  <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>{e}</span>
                </div>
              ))}
            </div>
          )}

          {hypothesis.likely_cause === 'cable_or_nic' && (
            <PortErrorDetail metrics={metrics} />
          )}

          <WhyWeThink cause={hypothesis.likely_cause} />

          {hypothesis.recommended_action && (
            <div style={{
              background:   (effectiveCause === 'healthy' || effectiveCause === 'global_wan_incident') ? '#22c55e0d' : '#eab3080d',
              border:       `1px solid ${(effectiveCause === 'healthy' || effectiveCause === 'global_wan_incident') ? '#22c55e33' : '#eab30833'}`,
              borderRadius: 'var(--radius)', padding: '10px 14px',
            }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 5px' }}>
                Recommended Action
              </p>
              <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.6 }}>
                → {hypothesis.recommended_action}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Timeline Panel ────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  port_errors:        '🔌',
  port_error:         '🔌',
  latency_spike:      '📡',
  incident:           '🚨',
  incident_created:   '🚨',
  incident_resolved:  '✅',
  device_online:      '🟢',
  device_offline:     '🔴',
}

function TimelinePanel({ timeline }: { timeline: TimelineEvent[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const sorted = useMemo(() => [...timeline].reverse(), [timeline])

  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <SectionHead>Timeline ({timeline.length} events — newest first)</SectionHead>
      {timeline.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0, fontStyle: 'italic' }}>No events in selected window</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, maxHeight: 380, overflowY: 'auto' }}>
          {sorted.map((ev, i) => {
            const color = SEV_COLORS[ev.severity] ?? '#6b7280'
            const isExp = expanded.has(i)
            return (
              <div
                key={i}
                onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })}
                style={{ display: 'flex', gap: 12, padding: '8px 4px', cursor: 'pointer', borderBottom: i < sorted.length - 1 ? '1px solid var(--border-dim)' : 'none' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 14 }}>{EVENT_ICONS[ev.event_type] ?? '⚪'}</span>
                  {i < sorted.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 4 }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-dim)', flexShrink: 0 }}>
                      {new Date(ev.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, flex: 1 }}>{ev.description}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color, border: `1px solid ${color}44`, borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>
                      {ev.severity}
                    </span>
                  </div>
                  {isExp && (
                    <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--text-dim)', display: 'flex', gap: 16 }}>
                      <span><strong>Type:</strong> {ev.event_type}</span>
                      <span><strong>Time:</strong> {new Date(ev.time).toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Metrics Panel ─────────────────────────────────────────────────────────────

function MetricsPanel({ metrics, detail }: { metrics: InvestigateMetrics; detail: DeviceDetail | null }) {
  const portErrors = (detail?.port_errors_24h ?? []).map(b => ({
    time:      new Date(b.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    rx_errors: b.rx_errors,
    tx_errors: b.tx_errors,
  }))

  const latency = (detail?.latency_to_gateway_24h ?? []).map(b => ({
    time:    new Date(b.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    avg_rtt: b.avg_rtt,
  }))

  const topDest = metrics.top_destinations.slice(0, 5).map(d => ({
    label: `${d.dst_ip ?? '?'} (${d.protocol_name})`.slice(0, 22),
    bytes: d.bytes,
  }))

  const noData = (msg: string) => (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 11 }}>{msg}</div>
  )

  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <SectionHead>Metrics</SectionHead>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>

        {/* Port errors */}
        <ChartCard title="Port Errors (24 h)">
          {portErrors.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={portErrors} margin={{ top: 0, right: 4, bottom: 0, left: -20 }}>
                <XAxis dataKey="time" tick={{ fontSize: 8, fill: 'var(--text-dim)' }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} allowDecimals={false} />
                <ReTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 6 }}
                  formatter={(v: unknown, name: unknown) => [`${v}`, name === 'rx_errors' ? 'RX errors' : 'TX errors']} />
                <Bar dataKey="rx_errors" stackId="e" fill="#ef4444" />
                <Bar dataKey="tx_errors" stackId="e" fill="#f87171" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : noData('No port error data')}
        </ChartCard>

        {/* Gateway latency */}
        <ChartCard title="Gateway Latency (24 h)">
          {latency.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <LineChart data={latency} margin={{ top: 0, right: 4, bottom: 0, left: -20 }}>
                <XAxis dataKey="time" tick={{ fontSize: 8, fill: 'var(--text-dim)' }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickFormatter={v => `${v}ms`} />
                <ReTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 6 }}
                  formatter={(v: unknown) => [`${v} ms`, 'RTT']} />
                <Line dataKey="avg_rtt" stroke="#22c55e" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          ) : noData('No latency data')}
        </ChartCard>

        {/* Bytes */}
        <ChartCard title="Bytes (Period)">
          <div style={{ height: 130, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, padding: '0 8px' }}>
            {([
              { label: 'Sent',     value: metrics.bytes_sent,     color: '#3b82f6' },
              { label: 'Received', value: metrics.bytes_received, color: '#22c55e' },
            ] as const).map(({ label, value, color }) => {
              const max = Math.max(metrics.bytes_sent, metrics.bytes_received, 1)
              return (
                <div key={label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11 }}>
                    <span style={{ color: 'var(--text-dim)' }}>{label}</span>
                    <span style={{ color, fontWeight: 700 }}>{fmt(value)}</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg-raised)', borderRadius: 3, border: '1px solid var(--border)' }}>
                    <div style={{ height: '100%', width: `${(value / max) * 100}%`, background: color, borderRadius: 3 }} />
                  </div>
                </div>
              )
            })}
            {/* Gateway/WAN loss is a global metric — shown in the global outage banner, not here */}
          </div>
        </ChartCard>

        {/* Top destinations */}
        <ChartCard title="Top Destinations">
          {topDest.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <BarChart layout="vertical" data={topDest} margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
                <XAxis type="number" tickFormatter={v => fmt(v as number)} tick={{ fontSize: 8, fill: 'var(--text-dim)' }} />
                <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 8, fill: 'var(--text)' }} />
                <ReTooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 6 }}
                  formatter={(v: unknown) => [fmt(Number(v)), 'Bytes']} />
                <Bar dataKey="bytes" radius={[0, 3, 3, 0]} label={{ position: 'right', formatter: (v: unknown) => fmt(Number(v)), fontSize: 9, fill: 'var(--text-dim)' }}>
                  {topDest.map((_, i) => <Cell key={i} fill={DEST_COLORS[i % DEST_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : noData('Enable NetFlow on pfSense to see traffic destinations')}
        </ChartCard>
      </div>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      flex: '1 1 240px', background: 'var(--bg-raised)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '12px 14px',
    }}>
      <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: '0 0 10px' }}>
        {title}
      </p>
      {children}
    </div>
  )
}

// ── Flows Panel ───────────────────────────────────────────────────────────────

function FlowsPanel({ ip, flows }: { ip: string; flows: RawFlow[] }) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const PAGE    = 50
  const pages   = Math.ceil(flows.length / PAGE)
  const visible = flows.slice((page - 1) * PAGE, page * PAGE)

  return (
    <div className="card" style={{ padding: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer', borderBottom: open ? '1px solid var(--border)' : 'none' }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
          Raw Flows — {flows.length} entries (last hour)
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {open && (
            <button
              onClick={e => { e.stopPropagation(); exportFlowsCsv(flows, ip) }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-raised)', color: 'var(--text-dim)', cursor: 'pointer' }}
            >
              <Download size={11} />
              CSV
            </button>
          )}
          {open ? <ChevronUp size={14} color="var(--text-dim)" /> : <ChevronDown size={14} color="var(--text-dim)" />}
        </div>
      </button>

      {open && (
        <>
          <div style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Source', 'Destination', 'Protocol', 'Bytes', 'Packets', 'Direction'].map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((f, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                    <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text)' }}>{f.src_ip}</td>
                    <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>{f.dst_ip}</td>
                    <td style={{ padding: '6px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                      {resolveProto(f.protocol, f.dst_port)}
                    </td>
                    <td style={{ padding: '6px 12px', color: 'var(--text)', fontWeight: 600 }}>{fmt(f.bytes)}</td>
                    <td style={{ padding: '6px 12px', color: 'var(--text-dim)' }}>{f.packets.toLocaleString()}</td>
                    <td style={{ padding: '6px 12px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                      {f.direction === 'inbound'  ? <span style={{ color: '#22c55e' }}>↓ in</span>
                       : f.direction === 'outbound' ? <span style={{ color: '#3b82f6' }}>↑ out</span>
                       : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div style={{ padding: '8px 16px', display: 'flex', gap: 4, alignItems: 'center', borderTop: '1px solid var(--border-dim)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: 1 }}>Page {page} of {pages}</span>
              {Array.from({ length: pages }, (_, i) => i + 1).map(pg => (
                <button key={pg} onClick={() => setPage(pg)} style={{ width: 26, height: 26, borderRadius: 'var(--radius-sm)', border: pg === page ? '1px solid var(--border-bright)' : '1px solid transparent', background: pg === page ? 'var(--bg-raised)' : 'transparent', color: pg === page ? 'var(--text-head)' : 'var(--text-dim)', fontSize: 12, cursor: 'pointer', fontWeight: pg === page ? 700 : 400 }}>{pg}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Incidents Panel ───────────────────────────────────────────────────────────

function IncidentsPanel({ deviceIncidents }: { deviceIncidents: IncidentRecord[] }) {
  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <SectionHead>Device Incidents (last 20)</SectionHead>
      {deviceIncidents.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0, fontStyle: 'italic' }}>No device-specific incidents recorded</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 4px' }}>
            {deviceIncidents.length} incident{deviceIncidents.length !== 1 ? 's' : ''} found
          </p>
          {deviceIncidents.map(inc => {
            const sev      = SEV_COLORS[inc.severity] ?? '#6b7280'
            const resolved = !!inc.resolved_at
            return (
              <div key={inc.id} style={{
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderLeft: `3px solid ${sev}`, borderRadius: 'var(--radius)', padding: '10px 14px',
              }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-head)', margin: '0 0 3px' }}>{inc.title}</p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: inc.root_cause ? 4 : 0 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    {new Date(inc.started_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 600 }}>{inc.category}</span>
                  <span style={{ fontSize: 10, color: resolved ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                    {resolved ? '✓ Resolved' : '⚡ Open'}
                  </span>
                </div>
                {inc.root_cause && (
                  <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>Root cause: {inc.root_cause}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Raw Port Metrics Panel ────────────────────────────────────────────────────

function RawPortMetricsPanel({ metrics, switchId }: { metrics: InvestigateMetrics; switchId: string | null | undefined }) {
  const [open, setOpen] = useState(false)
  const rows = metrics.raw_port_metrics ?? []

  const emptyMessage = !switchId
    ? 'This device is not connected to a monitored switch port'
    : 'No port data in selected time window'

  return (
    <div className="card" style={{ padding: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer',
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
          Raw Data — last {rows.length} port_metrics rows
        </span>
        {open ? <ChevronUp size={14} color="var(--text-dim)" /> : <ChevronDown size={14} color="var(--text-dim)" />}
      </button>

      {open && (
        <div style={{ overflow: 'auto' }}>
          {rows.length === 0 ? (
            <p style={{ padding: '16px 20px', color: 'var(--text-dim)', fontSize: 12, margin: 0, fontStyle: 'italic' }}>
              {emptyMessage}
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Timestamp', 'RX Errors', 'RX Dropped', 'RX Frags', 'RX Bytes', 'TX Bytes', 'Error Rate %'].map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rateColor = r.error_rate_pct > 0.1 ? '#ef4444' : r.error_rate_pct > 0.001 ? '#eab308' : 'var(--text-dim)'
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td style={{ padding: '5px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {new Date(r.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td style={{ padding: '5px 12px', color: r.rx_errors > 0 ? '#ef4444' : 'var(--text-dim)', fontWeight: r.rx_errors > 0 ? 700 : 400 }}>{r.rx_errors.toLocaleString()}</td>
                      <td style={{ padding: '5px 12px', color: r.rx_dropped > 0 ? '#f97316' : 'var(--text-dim)', fontWeight: r.rx_dropped > 0 ? 700 : 400 }}>{r.rx_dropped.toLocaleString()}</td>
                      <td style={{ padding: '5px 12px', color: r.rx_frags > 0 ? '#eab308' : 'var(--text-dim)', fontWeight: r.rx_frags > 0 ? 700 : 400 }}>{r.rx_frags.toLocaleString()}</td>
                      <td style={{ padding: '5px 12px', color: 'var(--text)', fontFamily: 'monospace' }}>{fmt(r.rx_bytes)}</td>
                      <td style={{ padding: '5px 12px', color: 'var(--text)', fontFamily: 'monospace' }}>{fmt(r.tx_bytes)}</td>
                      <td style={{ padding: '5px 12px', fontFamily: 'monospace', color: rateColor, fontWeight: r.error_rate_pct > 0.001 ? 700 : 400 }}>
                        {r.error_rate_pct.toFixed(6)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function NetworkInvestigate() {
  const navigate                        = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const now2hAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)

  const [searchInput, setSearchInput] = useState('')
  const [acOpen, setAcOpen]           = useState(false)
  const [acIndex, setAcIndex]         = useState(-1)
  const [selectedIp, setSelectedIp]   = useState<string | null>(null)
  const [dateStart, setDateStart]     = useState(toLocalInput(now2hAgo))
  const [dateEnd, setDateEnd]         = useState(toLocalInput(new Date()))
  const [devices, setDevices]         = useState<DeviceRow[]>([])
  const [invData, setInvData]         = useState<InvestigateResponse | null>(null)
  const [devDetail, setDevDetail]     = useState<DeviceDetail | null>(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState(false)
  const searchRef                     = useRef<HTMLInputElement>(null)
  const initialised                   = useRef(false)

  // ── Export Report ────────────────────────────────────────────────────────────
  function exportReport() {
    if (!invData || !selectedIp) return
    const d    = invData.device as Record<string, unknown> | null
    const hyp  = invData.hypothesis
    const tl   = invData.timeline
    const m    = invData.metrics

    const badge = (sev: string) => {
      const cls = sev === 'critical' ? 'critical' : sev === 'high' ? 'high' : sev === 'medium' ? 'medium' : 'low'
      return `<span class="print-badge print-badge-${cls}">${sev}</span>`
    }

    const tlRows = tl.slice().reverse().map(e =>
      `<tr><td>${new Date(e.time).toLocaleString()}</td><td>${badge(e.severity)}</td><td>${e.event_type}</td><td>${e.description}</td></tr>`
    ).join('')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Investigation Report — ${selectedIp}</title>
<style>
  body { font-family: Georgia, serif; font-size: 12pt; color: #111; padding: 24pt; max-width: 900px; margin: 0 auto; }
  h1   { font-size: 18pt; margin-bottom: 4pt; }
  h2   { font-size: 13pt; margin: 18pt 0 5pt; border-bottom: 1px solid #ccc; padding-bottom: 3pt; }
  p    { margin: 3pt 0; line-height: 1.5; }
  .meta { color: #666; font-size: 10pt; margin-bottom: 16pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 6pt; }
  th { background: #f0f0f0; border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; font-weight: 600; }
  td { border: 1px solid #ddd; padding: 3pt 6pt; }
  tr:nth-child(even) td { background: #f9f9f9; }
  .print-badge { display: inline-block; padding: 1pt 5pt; border-radius: 3pt; font-size: 9pt; font-weight: 700; text-transform: uppercase; }
  .print-badge-critical { background: #fee2e2; color: #b91c1c; }
  .print-badge-high     { background: #ffedd5; color: #c2410c; }
  .print-badge-medium   { background: #fef3c7; color: #92400e; }
  .print-badge-low      { background: #d1fae5; color: #065f46; }
  .diagnosis { background: #f9fafb; border-left: 4px solid #111; padding: 10pt 14pt; margin: 8pt 0; }
  .evidence-item::before { content: "• "; }
  @media print { @page { margin: 20mm; } }
</style>
</head>
<body>
<h1>Investigation Report</h1>
<p class="meta">
  Device: <strong>${selectedIp}</strong>
  ${d?.hostname ? ` · Hostname: <strong>${d.hostname}</strong>` : ''}
  · Generated: ${new Date().toLocaleString()}
  · Period: ${dateStart} → ${dateEnd}
</p>

${d ? `<h2>Device Info</h2>
<table>
  <tr><th>Field</th><th>Value</th></tr>
  ${Object.entries(d).filter(([k]) => !['switch_id','port_id'].includes(k)).map(([k,v]) =>
    `<tr><td>${k}</td><td>${v ?? '—'}</td></tr>`).join('')}
</table>` : ''}

<h2>Diagnosis</h2>
<div class="diagnosis">
  <p><strong>Likely cause:</strong> ${hyp.likely_cause.replace(/_/g, ' ')} &nbsp; <strong>Confidence:</strong> ${hyp.confidence}</p>
  <p><strong>Evidence:</strong></p>
  ${hyp.evidence.map(e => `<p class="evidence-item">${e}</p>`).join('')}
  <p style="margin-top:8pt"><strong>Recommended action:</strong> ${hyp.recommended_action}</p>
</div>

<h2>Metrics (selected period)</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Avg gateway RTT</td><td>${m.avg_rtt_gateway_ms != null ? m.avg_rtt_gateway_ms.toFixed(1) + ' ms' : '—'}</td></tr>
  <tr><td>Avg gateway packet loss</td><td>${m.avg_packet_loss_gateway_pct.toFixed(1)}%</td></tr>
  <tr><td>Avg WAN packet loss</td><td>${m.avg_packet_loss_wan_pct.toFixed(1)}%</td></tr>
  <tr><td>Port RX errors</td><td>${m.port_rx_errors}</td></tr>
  <tr><td>Port TX errors</td><td>${m.port_tx_errors}</td></tr>
  <tr><td>Bytes sent</td><td>${(m.bytes_sent / 1024 / 1024).toFixed(1)} MB</td></tr>
  <tr><td>Bytes received</td><td>${(m.bytes_received / 1024 / 1024).toFixed(1)} MB</td></tr>
</table>

<h2>Timeline (${tl.length} events)</h2>
${tl.length === 0 ? '<p>No events in selected period.</p>' : `
<table>
  <tr><th>Time</th><th>Severity</th><th>Type</th><th>Description</th></tr>
  ${tlRows}
</table>`}
</body>
</html>`

    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(html)
    w.document.close()
    w.onload = () => w.print()
  }

  // Load devices for autocomplete
  useEffect(() => {
    fetch('/api/network/devices')
      .then(r => r.ok ? r.json() : [])
      .then((d: DeviceRow[]) => setDevices(d))
      .catch(() => {})
  }, [])

  // Initialise from ?ip= URL param
  useEffect(() => {
    if (initialised.current) return
    initialised.current = true
    const urlIp = searchParams.get('ip')
    if (urlIp) { setSelectedIp(urlIp); setSearchInput(urlIp) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "/" focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Fetch when selectedIp / dates change
  useEffect(() => {
    if (!selectedIp) return
    let cancelled = false
    const load = async () => {
      setLoading(true); setError(false)
      try {
        const startISO = new Date(dateStart).toISOString()
        const endISO   = new Date(dateEnd).toISOString()
        const [invRes, devRes] = await Promise.allSettled([
          fetch(`/api/network/investigate?ip=${encodeURIComponent(selectedIp)}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`),
          fetch(`/api/network/device/${encodeURIComponent(selectedIp)}`),
        ])
        if (cancelled) return
        if (invRes.status === 'fulfilled' && invRes.value.ok) {
          setInvData(await invRes.value.json())
        } else {
          setError(true)
        }
        if (devRes.status === 'fulfilled' && devRes.value.ok) {
          setDevDetail(await devRes.value.json())
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [selectedIp, dateStart, dateEnd])

  // Autocomplete filter
  const acFiltered = useMemo(() =>
    !searchInput ? [] : devices.filter(d =>
      (d.hostname ?? '').toLowerCase().includes(searchInput.toLowerCase()) ||
      d.ip.toLowerCase().includes(searchInput.toLowerCase())
    ).slice(0, 8),
    [devices, searchInput]
  )

  function selectDevice(d: DeviceRow) {
    setSearchInput(d.hostname ?? d.ip)
    setSelectedIp(d.ip)
    setAcOpen(false)
    setAcIndex(-1)
    setSearchParams({ ip: d.ip })
  }

  function handleAnalyze() {
    const q = searchInput.trim()
    if (!q) return
    const match = devices.find(d =>
      d.ip === q || (d.hostname ?? '').toLowerCase() === q.toLowerCase()
    )
    const ip = match?.ip ?? q
    setSelectedIp(ip)
    setAcOpen(false)
    setAcIndex(-1)
    setSearchParams({ ip })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex(i => Math.min(i + 1, acFiltered.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setAcIndex(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter') {
      if (acIndex >= 0 && acFiltered[acIndex]) selectDevice(acFiltered[acIndex])
      else handleAnalyze()
    }
    if (e.key === 'Escape') { setAcOpen(false); setAcIndex(-1) }
  }

  function clearSearch() {
    setSearchInput(''); setSelectedIp(null); setInvData(null); setDevDetail(null); setSearchParams({})
  }

  // Derive typed flow + incident lists from DeviceDetail
  const flows: RawFlow[] = (devDetail?.flows_last_hour ?? []).map(f => ({
    src_ip:   f.src_ip   as string,
    dst_ip:   f.dst_ip   as string,
    dst_port: f.dst_port as number | null,
    protocol: f.protocol as number | null,
    direction:f.direction as string | null,
    bytes:    f.bytes    as number,
    packets:  f.packets  as number,
  }))

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Search header ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, flexShrink: 0,
        padding: selectedIp ? '0' : '32px 0 12px',
      }}>
        {!selectedIp && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 36, height: 36, borderRadius: 'var(--radius)', background: 'var(--accent-dim)', border: '1px solid var(--border-bright)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Activity size={18} color="var(--accent)" />
            </div>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-head)', margin: 0 }}>Investigate</h1>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>Diagnose any device by IP or hostname</p>
            </div>
          </div>
        )}

        {/* Search bar */}
        <div style={{ position: 'relative', width: '100%', maxWidth: 700 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {/* Input */}
            <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 180 }}>
              <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
              <input
                ref={searchRef}
                value={searchInput}
                onChange={e => { setSearchInput(e.target.value); setAcOpen(true); setAcIndex(-1) }}
                onKeyDown={handleKeyDown}
                onFocus={() => setAcOpen(true)}
                onBlur={() => setTimeout(() => setAcOpen(false), 150)}
                placeholder="IP address or hostname…"
                style={{
                  width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border-bright)',
                  borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 14,
                  padding: '10px 36px 10px 36px', outline: 'none', boxSizing: 'border-box',
                }}
              />
              {searchInput && (
                <button onClick={clearSearch} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Date pickers */}
            {(['start', 'end'] as const).map(which => (
              <input
                key={which}
                type="datetime-local"
                value={which === 'start' ? dateStart : dateEnd}
                onChange={e => which === 'start' ? setDateStart(e.target.value) : setDateEnd(e.target.value)}
                style={{
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', color: 'var(--text)',
                  fontSize: 11, padding: '6px 10px', outline: 'none', cursor: 'pointer',
                  colorScheme: 'dark', flex: '0 0 auto',
                }}
              />
            ))}

            <button
              onClick={handleAnalyze}
              disabled={!searchInput.trim()}
              style={{
                padding: '10px 22px', fontSize: 13, fontWeight: 700,
                borderRadius: 'var(--radius)', cursor: searchInput.trim() ? 'pointer' : 'not-allowed',
                border: '1px solid var(--border-bright)',
                background: searchInput.trim() ? 'var(--accent)' : 'var(--bg-raised)',
                color: searchInput.trim() ? '#000' : 'var(--text-dim)',
                flexShrink: 0, transition: 'background 0.15s',
              }}
            >
              Analyze
            </button>

            {invData && (
              <button
                onClick={exportReport}
                title="Print / export investigation report"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '10px 14px', fontSize: 12, fontWeight: 600,
                  borderRadius: 'var(--radius)', cursor: 'pointer',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-raised)',
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                }}
              >
                <Download size={13} /> Export Report
              </button>
            )}
          </div>

          {/* Autocomplete */}
          {acOpen && acFiltered.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
              background: 'var(--bg-surface)', border: '1px solid var(--border-bright)',
              borderTop: 'none', borderRadius: '0 0 var(--radius) var(--radius)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden',
            }}>
              {acFiltered.map((d, i) => (
                <div
                  key={d.ip}
                  onMouseDown={() => selectDevice(d)}
                  style={{
                    padding: '9px 14px', cursor: 'pointer',
                    background: i === acIndex ? 'var(--bg-raised)' : 'transparent',
                    borderBottom: i < acFiltered.length - 1 ? '1px solid var(--border-dim)' : 'none',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: d.is_online ? '#22c55e' : '#6b7280', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{d.hostname ?? d.ip}</span>
                  {d.hostname && <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-dim)' }}>{d.ip}</span>}
                  {d.device_type && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{d.device_type}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {!selectedIp && (
          <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Press{' '}
            <kbd style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontFamily: 'monospace' }}>
              /
            </kbd>{' '}
            to search
          </p>
        )}
      </div>

      {/* ── Empty state ───────────────────────────────────────────────────────── */}
      {!selectedIp && <ScenarioCards onFocusSearch={() => searchRef.current?.focus()} />}

      {/* ── Loading ───────────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[100, 160, 220, 280].map((h, i) => (
            <div key={i} className="card" style={{ height: h, animation: 'pulse 1.4s ease-in-out infinite' }} />
          ))}
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────────────────────── */}
      {error && !loading && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Activity size={36} color="var(--text-dim)" strokeWidth={1} style={{ marginBottom: 12 }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 4 }}>Could not load investigation data</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 16 }}>
            Ensure the collector is running and the IP is in the device registry.
          </p>
          <button
            onClick={() => { const ip = selectedIp; setSelectedIp(null); setTimeout(() => setSelectedIp(ip), 50) }}
            style={{ padding: '6px 16px', fontSize: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-bright)', background: 'var(--accent-dim)', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Results ───────────────────────────────────────────────────────────── */}
      {!loading && !error && invData && selectedIp && (
        <>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              Investigation: <strong style={{ color: 'var(--text)' }}>
                {(invData.device?.hostname as string | undefined) ?? selectedIp}
              </strong>
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>·</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {new Date(dateStart).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {' → '}
              {new Date(dateEnd).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <button
              onClick={() => navigate(`/network/traffic?ip=${selectedIp}`)}
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 11, fontWeight: 600, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer' }}
            >
              <ExternalLink size={11} />
              View Traffic
            </button>
          </div>

          <DevicePanel           ip={selectedIp} inv={invData} detail={devDetail} />
          {invData.global_incidents.length > 0 && (
            <GlobalOutageBanner incidents={invData.global_incidents} />
          )}
          <DiagnosisPanel        hypothesis={invData.hypothesis} metrics={invData.metrics} globalIncidents={invData.global_incidents} />
          <TimelinePanel         timeline={invData.timeline} />
          {invData.metrics.bytes_sent === 0 && invData.metrics.bytes_received === 0 && invData.timeline.length === 0 ? (
            <div className="card" style={{ padding: '24px 20px', textAlign: 'center' }}>
              <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: 0 }}>No data available for this device in the selected window</p>
              <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '6px 0 0', fontStyle: 'italic' }}>
                Try widening the time range or check that the collector was running during this period.
              </p>
            </div>
          ) : (
            <MetricsPanel        metrics={invData.metrics} detail={devDetail} />
          )}
          <FlowsPanel            ip={selectedIp} flows={flows} />
          <IncidentsPanel        deviceIncidents={invData.device_incidents} />
          <RawPortMetricsPanel   metrics={invData.metrics} switchId={(invData.device?.switch_id as string | null) ?? devDetail?.switch_id} />
        </>
      )}
    </div>
  )
}
