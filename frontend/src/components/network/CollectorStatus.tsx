import { useEffect, useRef, useState } from 'react'
import { X, ChevronDown, ChevronUp, Terminal } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface CollectorData {
  online:    boolean
  last_seen: string | null
  sources:   Record<string, unknown>
}

interface OverviewResponse {
  collector: CollectorData
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api/network'

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr ago`
  return `${Math.floor(h / 24)}d ago`
}

// Source names and descriptions shown in the modal
const SOURCE_META: Record<string, { label: string; desc: string }> = {
  goflow2:  { label: 'goflow2 (NetFlow)',   desc: 'Collects flow records from pfSense via UDP 9995' },
  telegraf: { label: 'Telegraf (UniFi)',     desc: 'Polls UniFi controller for port and device metrics' },
  fping:    { label: 'fping (Latency)',      desc: 'Probes gateway and WAN targets every 30 seconds' },
}

const HOW_TO_START = `# Start the STAR collector

## Docker Compose (recommended)
cd /opt/star-collector
docker compose up -d

## Check status
docker compose ps
docker compose logs -f

## Verify it is sending data
docker compose logs fping | tail -20
docker compose logs telegraf | tail -20`

// ── Modal ──────────────────────────────────────────────────────────────────────

function Modal({ collector, onClose }: { collector: CollectorData; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [instructionsOpen, setInstructionsOpen] = useState(false)

  // Close on overlay click
  function handleOverlay(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  // Close on Escape
  useEffect(() => {
    function handle(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onClose])

  const sourceEntries = Object.entries(collector.sources)

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlay}
      style={{
        position: 'fixed', inset: 0,
        background: 'var(--bg-overlay)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300,
      }}
    >
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-bright)',
        borderRadius: 'var(--radius-lg)',
        width: '100%', maxWidth: 480,
        maxHeight: '80vh',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        margin: '0 16px',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              backgroundColor: collector.online ? 'var(--green)' : 'var(--amber)',
              boxShadow: collector.online ? '0 0 8px var(--green)' : '0 0 8px var(--amber)',
              flexShrink: 0,
            }} />
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-head)' }}>
              Collector {collector.online ? 'Online' : 'Offline'}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

          {/* Last seen */}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>
            Last heartbeat: <strong style={{ color: 'var(--text)' }}>{ago(collector.last_seen)}</strong>
          </p>

          {/* Data sources */}
          <h4 style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10,
          }}>
            Data sources
          </h4>

          {sourceEntries.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 16 }}>
              No source data received yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {sourceEntries.map(([key, val]) => {
                const meta  = SOURCE_META[key]
                const label = meta?.label ?? key
                const desc  = meta?.desc  ?? ''

                // val may be a timestamp string, an object {last_seen, status}, or bool
                let lastSeen: string | null = null
                let isOk = true
                if (typeof val === 'string') {
                  lastSeen = val
                } else if (val && typeof val === 'object') {
                  const v = val as Record<string, unknown>
                  if (typeof v.last_seen === 'string') lastSeen = v.last_seen
                  if (typeof v.status    === 'string') isOk = v.status === 'ok' || v.status === 'healthy'
                } else if (typeof val === 'boolean') {
                  isOk = val
                }

                return (
                  <div key={key} style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    borderLeft: `3px solid ${isOk ? 'var(--green)' : 'var(--amber)'}`,
                    borderRadius: 'var(--radius)',
                    padding: '10px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-head)' }}>{label}</span>
                      <span style={{ fontSize: 11, color: isOk ? 'var(--green)' : 'var(--amber)' }}>
                        {isOk ? 'OK' : 'No data'}
                      </span>
                    </div>
                    {desc && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>{desc}</p>
                    )}
                    {lastSeen && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                        Last data: {ago(lastSeen)}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* How to start */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <button
              onClick={() => setInstructionsOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 13, padding: 0, width: '100%',
              }}
            >
              <Terminal size={14} />
              How to start the collector
              {instructionsOpen ? <ChevronUp size={13} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={13} style={{ marginLeft: 'auto' }} />}
            </button>

            {instructionsOpen && (
              <pre style={{
                marginTop: 12,
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '12px 14px',
                fontSize: 12,
                color: 'var(--text)',
                overflowX: 'auto',
                lineHeight: 1.6,
                fontFamily: "'Courier New', monospace",
                whiteSpace: 'pre-wrap',
              }}>
                {HOW_TO_START}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── CollectorStatus ────────────────────────────────────────────────────────────

interface Props {
  /** If you already have overview data, pass it here to avoid a second fetch */
  collector?: CollectorData
}

export default function CollectorStatus({ collector: propCollector }: Props) {
  const [collector, setCollector] = useState<CollectorData | null>(propCollector ?? null)
  const [modalOpen, setModalOpen] = useState(false)

  // Only fetch if not provided as prop
  useEffect(() => {
    if (propCollector) { setCollector(propCollector); return }
    fetch(`${BASE}/overview`)
      .then(r => r.ok ? r.json() as Promise<OverviewResponse> : Promise.reject())
      .then(d => setCollector(d.collector))
      .catch(() => {/* silent */})
  }, [propCollector])

  // Keep in sync if prop changes
  useEffect(() => {
    if (propCollector) setCollector(propCollector)
  }, [propCollector])

  if (!collector) return null

  const isOnline  = collector.online
  const lastSeen  = collector.last_seen

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        title={isOnline ? 'Collector online — click for details' : 'Collector offline — click for details'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          background: 'var(--bg-surface)',
          border: `1px solid ${isOnline ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)'}`,
          borderRadius: 20,
          padding: '5px 12px',
          cursor: 'pointer',
          transition: 'border-color 0.2s',
        }}
      >
        <span style={{
          width: 8, height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          backgroundColor: isOnline ? 'var(--green)' : 'var(--amber)',
          boxShadow: isOnline ? '0 0 6px var(--green)' : '0 0 6px var(--amber)',
          animation: isOnline ? 'status-dot-pulse 2.5s ease-in-out infinite' : 'none',
        }} />
        <span style={{
          fontSize: 12,
          fontWeight: 500,
          color: isOnline ? 'var(--green)' : 'var(--amber)',
          whiteSpace: 'nowrap',
        }}>
          {isOnline ? 'Collector online' : `Collector offline${lastSeen ? ` · ${ago(lastSeen)}` : ''}`}
        </span>
      </button>

      {modalOpen && (
        <Modal collector={collector} onClose={() => setModalOpen(false)} />
      )}

      <style>{`
        @keyframes status-dot-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </>
  )
}
