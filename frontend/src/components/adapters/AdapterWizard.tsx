import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronRight, ChevronLeft, CheckCircle, Loader2, AlertTriangle, Wifi, Shield, Activity, Globe } from 'lucide-react'
import { toast } from 'sonner'
import { createSource, testSource } from '../../lib/api'

interface Props { onClose: () => void; onComplete: () => void }

type AdapterType = 'pfsense' | 'ninjarmm' | 'pingplotter' | 'custom'

interface AdapterDef {
  id:       AdapterType
  name:     string
  icon:     React.ReactNode
  desc:     string
  fields:   Array<{ key: string; label: string; type: 'text' | 'number' | 'password'; placeholder: string; default?: string }>
}

const ADAPTERS: AdapterDef[] = [
  {
    id: 'pfsense', name: 'pfSense', icon: <Shield size={22} />, desc: 'Syslog UDP listener for firewall events, WAN status, VPN tunnels, and DHCP',
    fields: [
      { key: 'port', label: 'Syslog UDP Port', type: 'number', placeholder: '514', default: '514' },
      { key: 'host', label: 'Listen Host', type: 'text', placeholder: '0.0.0.0', default: '0.0.0.0' },
    ],
  },
  {
    id: 'ninjarmm', name: 'NinjaRMM', icon: <Activity size={22} />, desc: 'Webhook receiver for device offline, disk/CPU/RAM alerts, AV status, and patch compliance',
    fields: [
      { key: 'webhook_secret', label: 'Webhook Secret (optional)', type: 'password', placeholder: 'Leave blank to skip validation' },
    ],
  },
  {
    id: 'pingplotter', name: 'PingPlotter', icon: <Wifi size={22} />, desc: 'Webhook receiver for packet loss, latency spikes, unreachable targets, and route changes',
    fields: [
      { key: 'webhook_secret', label: 'Webhook Secret (optional)', type: 'password', placeholder: 'Leave blank to skip validation' },
      { key: 'loss_threshold', label: 'Packet Loss Threshold (%)', type: 'number', placeholder: '1', default: '1' },
      { key: 'latency_threshold', label: 'Latency Threshold (ms)', type: 'number', placeholder: '100', default: '100' },
    ],
  },
  {
    id: 'custom', name: 'Custom Webhook', icon: <Globe size={22} />, desc: 'Generic webhook endpoint — any JSON payload routed through the alert engine',
    fields: [
      { key: 'slug', label: 'Source Slug (URL-safe name)', type: 'text', placeholder: 'my-source' },
      { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'My Custom Source' },
    ],
  },
]

const STEPS = ['Choose Adapter', 'Configure', 'Test', 'Done']

export default function AdapterWizard({ onClose, onComplete }: Props) {
  const [step, setStep]       = useState(0)
  const [selected, setSelected] = useState<AdapterType | null>(null)
  const [config, setConfig]   = useState<Record<string, string>>({})
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk]   = useState<boolean | null>(null)
  const [createdSourceId, setCreatedSourceId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const adapter = ADAPTERS.find(a => a.id === selected)

  const handleSelect = (id: AdapterType) => {
    setSelected(id)
    // Pre-fill defaults
    const def = ADAPTERS.find(a => a.id === id)!
    const defaults: Record<string, string> = {}
    def.fields.forEach(f => { if (f.default) defaults[f.key] = f.default })
    setConfig(defaults)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestOk(null)
    try {
      let sourceId = createdSourceId
      if (sourceId === null) {
        setCreating(true)
        const isCustom = selected === 'custom'
        const slug = isCustom ? config['slug'] : selected!
        const name = isCustom ? (config['display_name'] || config['slug']) : adapter!.name
        const sourceType = selected === 'pfsense' ? 'syslog' : 'webhook'
        const created = await createSource({
          name,
          slug,
          adapter: isCustom ? 'custom' : selected!,
          type: sourceType as 'webhook' | 'syslog' | 'poll' | 'push',
          enabled: true,
          config: isCustom
            ? {}
            : Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'slug' && k !== 'display_name')),
        })
        sourceId = created.id
        setCreatedSourceId(created.id)
        setCreating(false)
      }
      await testSource(sourceId)
      setTestOk(true)
    } catch {
      setTestOk(false)
    } finally {
      setTesting(false)
      setCreating(false)
    }
  }

  const handleFinish = () => {
    onComplete()
    onClose()
  }

  return (
    <div className="overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30 }} onClick={onClose}>
      <motion.div
        initial={{ scale: 0.94, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 16 }}
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        onClick={e => e.stopPropagation()}
        style={{
          width: 520, maxWidth: '95vw',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-bright)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-head)' }}>Add Adapter</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>Step {step + 1} of {STEPS.length} — {STEPS[step]}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 4 }}><X size={16} /></button>
        </div>

        {/* Step progress */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)' }}>
          {STEPS.map((label, i) => (
            <div key={i} style={{
              flex: 1, padding: '6px 4px', textAlign: 'center',
              fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
              color: i <= step ? 'var(--accent)' : 'var(--text-dim)',
              borderBottom: `2px solid ${i === step ? 'var(--accent)' : 'transparent'}`,
              transition: 'color 0.2s, border-color 0.2s',
            }}>
              {label}
            </div>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '24px 20px', minHeight: 260 }}>
          <AnimatePresence mode="wait">
            {/* Step 0: Choose */}
            {step === 0 && (
              <motion.div key="step0" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.15 }}>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
                  Select the type of adapter to connect to your dashboard.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ADAPTERS.map(a => (
                    <div
                      key={a.id}
                      onClick={() => handleSelect(a.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        padding: '12px 14px',
                        borderRadius: 'var(--radius)',
                        border: `1px solid ${selected === a.id ? 'var(--accent)' : 'var(--border)'}`,
                        background: selected === a.id ? 'var(--accent-dim)' : 'var(--bg-raised)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ color: selected === a.id ? 'var(--accent)' : 'var(--text-dim)', flexShrink: 0 }}>
                        {a.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-head)', marginBottom: 2 }}>{a.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.desc}</div>
                      </div>
                      {selected === a.id && <CheckCircle size={16} color="var(--accent)" style={{ flexShrink: 0 }} />}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Step 1: Configure */}
            {step === 1 && adapter && (
              <motion.div key="step1" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.15 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                  <div style={{ color: 'var(--accent)' }}>{adapter.icon}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-head)' }}>{adapter.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{adapter.desc}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {adapter.fields.map(f => (
                    <div key={f.key}>
                      <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 5, fontWeight: 500 }}>
                        {f.label}
                      </label>
                      <input
                        className="input"
                        type={f.type}
                        placeholder={f.placeholder}
                        value={config[f.key] ?? ''}
                        onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                  {adapter.id === 'pfsense' && window.location.protocol === 'https:' && (
                    <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 11, color: '#eab308', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span><strong>Cloud deployment detected.</strong> Railway does not expose UDP ports — the pfSense syslog listener will not receive data. Consider a self-hosted deployment for pfSense integration.</span>
                    </div>
                  )}
                  {adapter.id === 'ninjarmm' && (
                    <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
                      Configure NinjaRMM webhook URL to: <span className="mono" style={{ color: 'var(--accent)' }}>{window.location.origin}/api/ingest/ninjarmm</span>
                    </div>
                  )}
                  {adapter.id === 'pingplotter' && (
                    <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
                      Configure PingPlotter webhook URL to: <span className="mono" style={{ color: 'var(--accent)' }}>{window.location.origin}/api/ingest/pingplotter</span>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* Step 2: Test */}
            {step === 2 && (
              <motion.div key="step2" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.15 }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, paddingTop: 20 }}>
                {testing && (
                  <>
                    <Loader2 size={36} color="var(--accent)" style={{ animation: 'spin 1s linear infinite' }} />
                    <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Testing connection…</div>
                  </>
                )}
                {!testing && testOk === null && (
                  <>
                    <div style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center' }}>
                      Send a test event to verify the adapter is configured correctly.
                    </div>
                    <button className="btn btn-primary" onClick={handleTest} style={{ gap: 8 }}>
                      <Activity size={14} /> Run Connection Test
                    </button>
                  </>
                )}
                {!testing && testOk === true && (
                  <>
                    <CheckCircle size={40} color="var(--green)" style={{ filter: 'drop-shadow(0 0 8px var(--green))' }} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--green)' }}>Connection successful</div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Adapter is reachable and responding correctly.</div>
                  </>
                )}
                {!testing && testOk === false && (
                  <>
                    <AlertTriangle size={40} color="var(--red)" />
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--red)' }}>Connection failed</div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Check your configuration and try again.</div>
                    <button className="btn" onClick={handleTest}>Retry</button>
                  </>
                )}
              </motion.div>
            )}

            {/* Step 3: Done */}
            {step === 3 && (
              <motion.div key="step3" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2 }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, paddingTop: 20 }}>
                <CheckCircle size={48} color="var(--green)" style={{ filter: 'drop-shadow(0 0 12px var(--green))' }} />
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-head)' }}>{adapter?.name} added</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', textAlign: 'center', maxWidth: 320 }}>
                  The adapter has been registered and will appear in your Sources page. Events will start appearing in the dashboard once data is received.
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer nav */}
        <div style={{
          padding: '14px 20px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button
            className="btn"
            onClick={() => setStep(s => s - 1)}
            disabled={step === 0}
            style={{ gap: 6, opacity: step === 0 ? 0.4 : 1 }}
          >
            <ChevronLeft size={14} /> Back
          </button>

          {step < 3 ? (
            <button
              className="btn btn-primary"
              onClick={() => {
                if (step === 1) {
                  if (selected === 'custom' && !config['slug']) { toast.warning('Please enter a source slug'); return }
                  setStep(s => s + 1)
                } else if (step === 2) {
                  if (testOk === null) { handleTest().then(() => setStep(3)) } else { setStep(3) }
                } else {
                  setStep(s => s + 1)
                }
              }}
              disabled={(step === 0 && !selected) || creating}
              style={{ gap: 6 }}
            >
              {step === 2 ? 'Finish Setup' : 'Continue'} <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleFinish} style={{ gap: 6 }}>
              <CheckCircle size={14} /> Done
            </button>
          )}
        </div>
      </motion.div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
