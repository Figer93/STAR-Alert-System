import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Circle, ChevronDown, ChevronUp, X, Loader } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

type StepStatus = 'loading' | 'ok' | 'pending'

interface Step {
  id:           string
  label:        string
  status:       StepStatus
  instructionId?: string
}

interface OverviewResponse {
  collector: { online: boolean; sources: Record<string, unknown> }
}

interface DeviceRow { ip: string }

// ── Constants ──────────────────────────────────────────────────────────────────

const BASE        = (import.meta.env.VITE_API_URL ?? '') + '/api/network'
const STORAGE_KEY = 'star_network_setup_dismissed'

// ── Instruction content ────────────────────────────────────────────────────────

interface Instruction {
  title: string
  steps: string[]
}

const INSTRUCTIONS: Record<string, Instruction> = {
  database: {
    title: 'Connect the database',
    steps: [
      'Copy .env.example to .env in the backend directory.',
      'Set DATABASE_URL to your Supabase connection string (postgresql+asyncpg://...).',
      'Run: alembic upgrade head',
      'Restart the backend service.',
      'The /health endpoint should return {"status":"ok"}.',
    ],
  },
  collector: {
    title: 'Start the collector',
    steps: [
      'SSH into your on-premise Linux host.',
      'Clone the repo and navigate to the /collector directory.',
      'Copy collector/.env.example to collector/.env and fill in your credentials.',
      'Run: docker compose up -d',
      'Verify with: docker compose ps — all services should show "Up".',
      'Wait up to 60 seconds for the first heartbeat to appear in the dashboard.',
    ],
  },
  netflow: {
    title: 'Enable NetFlow on pfSense',
    steps: [
      'Log in to pfSense → System → Package Manager → Available Packages.',
      'Search for "softflowd" → click Install.',
      'Go to Services → softflowd.',
      'Set Interface to LAN (or WAN if you want internet traffic).',
      'Set Host to your collector IP address.',
      'Set Port to 9995.',
      'Set Version to NetFlow v9.',
      'Click Save, then click Start.',
      'Traffic should appear in the collector logs within 30 seconds.',
    ],
  },
  unifi: {
    title: 'Connect the UniFi API',
    steps: [
      'Open your UniFi Controller → Settings → Admins.',
      'Click Add Admin.',
      'Username: star-monitor',
      'Role: Read Only',
      'Note the password — you will not see it again.',
      'Open collector/.env and set:',
      '  UNIFI_HOST=https://your-controller-ip',
      '  UNIFI_USER=star-monitor',
      '  UNIFI_PASS=your-password',
      '  UNIFI_SITE=default  (or your site name)',
      'Restart the collector: docker compose restart telegraf',
    ],
  },
}

// ── Instruction modal ──────────────────────────────────────────────────────────

function InstructionModal({ id, onClose }: { id: string; onClose: () => void }) {
  const ins = INSTRUCTIONS[id]
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handle(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onClose])

  if (!ins) return null

  return (
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
      style={{
        position: 'fixed', inset: 0,
        background: 'var(--bg-overlay)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 400,
      }}
    >
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-bright)',
        borderRadius: 'var(--radius-lg)',
        width: '100%', maxWidth: 500,
        maxHeight: '80vh', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        margin: '0 16px',
      }}>
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-head)' }}>{ins.title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <ol style={{
          flex: 1, overflowY: 'auto',
          padding: '20px 24px',
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          listStyleType: 'none',
        }}>
          {ins.steps.map((step, i) => (
            <li key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{
                minWidth: 22, height: 22,
                borderRadius: '50%',
                background: 'var(--accent-dim)',
                border: '1px solid var(--accent)',
                color: 'var(--blue)',
                fontSize: 11, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {i + 1}
              </span>
              <span style={{
                fontSize: 13, color: 'var(--text)',
                lineHeight: 1.5,
                fontFamily: step.startsWith('  ') ? "'Courier New', monospace" : 'inherit',
                whiteSpace: 'pre',
              }}>
                {step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

// ── SetupGuide ─────────────────────────────────────────────────────────────────

export default function SetupGuide() {
  const dismissed = localStorage.getItem(STORAGE_KEY) === 'true'

  const [visible, setVisible]   = useState(!dismissed)
  const [collapsed, setCollapsed] = useState(false)
  const [steps, setSteps]       = useState<Step[]>([
    { id: 'database',  label: 'Database connected',          status: 'loading' },
    { id: 'collector', label: 'Collector running',           status: 'loading' },
    { id: 'netflow',   label: 'NetFlow enabled on pfSense',  status: 'loading', instructionId: 'netflow' },
    { id: 'unifi',     label: 'UniFi API connected',         status: 'loading', instructionId: 'unifi' },
    { id: 'devices',   label: 'First devices discovered',    status: 'loading' },
  ])
  const [activeModal, setActiveModal] = useState<string | null>(null)
  const initialised = useRef(false)

  const setStep = useCallback((id: string, status: StepStatus) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, status } : s))
  }, [])

  useEffect(() => {
    if (!visible || initialised.current) return
    initialised.current = true

    // 1. Database
    fetch((import.meta.env.VITE_API_URL ?? '') + '/health')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { status?: string }) => setStep('database', d.status === 'ok' ? 'ok' : 'pending'))
      .catch(() => setStep('database', 'pending'))

    // 2. Collector + 3. NetFlow (goflow2) + 4. UniFi (telegraf)
    fetch(`${BASE}/overview`)
      .then(r => r.ok ? r.json() as Promise<OverviewResponse> : Promise.reject())
      .then(d => {
        const c = d.collector
        setStep('collector', c.online ? 'ok' : 'pending')

        const sources = c.sources ?? {}
        setStep('netflow', 'goflow2' in sources ? 'ok' : 'pending')
        setStep('unifi',   'telegraf' in sources ? 'ok' : 'pending')
      })
      .catch(() => {
        setStep('collector', 'pending')
        setStep('netflow',   'pending')
        setStep('unifi',     'pending')
      })

    // 5. Devices
    fetch(`${BASE}/devices`)
      .then(r => r.ok ? r.json() as Promise<DeviceRow[]> : Promise.reject())
      .then(d => setStep('devices', d.length > 0 ? 'ok' : 'pending'))
      .catch(() => setStep('devices', 'pending'))
  }, [visible, setStep])

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, 'true')
    setVisible(false)
  }

  if (!visible) return null

  const doneCount = steps.filter(s => s.status === 'ok').length
  const allDone   = doneCount === steps.length

  return (
    <>
      <div style={{
        background: allDone ? 'rgba(34,197,94,0.06)' : 'var(--bg-surface)',
        border: `1px solid ${allDone ? 'rgba(34,197,94,0.25)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        marginBottom: 24,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 12,
          cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
        }}
          onClick={() => setCollapsed(c => !c)}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-head)' }}>
                {allDone ? '✅ Setup complete' : 'Network Monitor setup'}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 600,
                color: allDone ? 'var(--green)' : 'var(--amber)',
                background: allDone ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
                borderRadius: 20,
                padding: '2px 8px',
              }}>
                {doneCount}/{steps.length}
              </span>
            </div>
            {!allDone && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Complete these steps to start receiving network data
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {collapsed ? <ChevronDown size={15} style={{ color: 'var(--text-muted)' }} /> : <ChevronUp size={15} style={{ color: 'var(--text-muted)' }} />}
            <button
              onClick={e => { e.stopPropagation(); dismiss() }}
              title="Dismiss setup guide"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', padding: '2px 4px',
                display: 'flex', alignItems: 'center',
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Steps */}
        {!collapsed && (
          <div style={{ padding: '12px 18px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {steps.map(step => (
              <div key={step.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius)',
                background: step.status === 'ok' ? 'rgba(34,197,94,0.05)' : 'transparent',
              }}>
                {/* Icon */}
                {step.status === 'loading' && (
                  <Loader size={16} style={{ color: 'var(--text-muted)', flexShrink: 0, animation: 'spin 1.2s linear infinite' }} />
                )}
                {step.status === 'ok' && (
                  <CheckCircle2 size={16} style={{ color: 'var(--green)', flexShrink: 0 }} />
                )}
                {step.status === 'pending' && (
                  <Circle size={16} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                )}

                {/* Label */}
                <span style={{
                  flex: 1,
                  fontSize: 13,
                  color: step.status === 'ok' ? 'var(--text-muted)' : 'var(--text)',
                  textDecoration: step.status === 'ok' ? 'line-through' : 'none',
                  textDecorationColor: 'var(--text-dim)',
                }}>
                  {step.label}
                </span>

                {/* How to set up */}
                {step.status === 'pending' && step.instructionId && (
                  <button
                    onClick={() => setActiveModal(step.instructionId!)}
                    style={{
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--blue)',
                      fontSize: 11,
                      padding: '3px 9px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    How to set up
                  </button>
                )}
                {step.status === 'pending' && !step.instructionId && (
                  <button
                    onClick={() => setActiveModal(step.id)}
                    style={{
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--blue)',
                      fontSize: 11,
                      padding: '3px 9px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    How to set up
                  </button>
                )}
              </div>
            ))}

            {allDone && (
              <button
                onClick={dismiss}
                style={{
                  marginTop: 8, alignSelf: 'flex-end',
                  background: 'rgba(34,197,94,0.12)',
                  border: '1px solid rgba(34,197,94,0.25)',
                  color: 'var(--green)',
                  borderRadius: 'var(--radius)',
                  padding: '7px 16px',
                  fontSize: 12, fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Dismiss guide
              </button>
            )}
          </div>
        )}
      </div>

      {activeModal && (
        <InstructionModal id={activeModal} onClose={() => setActiveModal(null)} />
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  )
}
