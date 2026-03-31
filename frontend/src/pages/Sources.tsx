import React, { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical, Plus, Radio, Zap, Loader2, Trash2,
  ChevronDown, ChevronUp, Copy, BookOpen, Activity,
  Wifi, Shield, Globe, X, CheckCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Source } from '../types'
import { getSources, updateSource, testSource, deleteSource } from '../lib/api'
import AdapterWizard from '../components/adapters/AdapterWizard'

function relativeTime(iso: string | null) {
  if (!iso) return 'Never'
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  return new Date(iso).toLocaleString()
}

function isStale(iso: string | null) {
  if (!iso) return false
  return (Date.now() - new Date(iso).getTime()) > 5 * 60 * 1000
}

const STATUS_DOT: Record<string, string> = {
  online: 'var(--green)', offline: 'var(--red)', unknown: 'var(--text-dim)',
}
const STATUS_PILL_BG: Record<string, string> = {
  online:  'rgba(34,197,94,0.10)',
  offline: 'rgba(239,68,68,0.10)',
  unknown: 'rgba(100,116,139,0.08)',
}
const STATUS_PILL_BORDER: Record<string, string> = {
  online:  'rgba(34,197,94,0.25)',
  offline: 'rgba(239,68,68,0.25)',
  unknown: 'rgba(100,116,139,0.15)',
}
const STATUS_TEXT: Record<string, string> = {
  online: 'var(--green)', offline: 'var(--red)', unknown: 'var(--text-dim)',
}

// ─── Sortable source card ─────────────────────────────────────────────────────
function SourceCard({
  source, testing, testResult, onToggle, onTest, onDelete,
  verifying, verifyCountdown, verifyResult, onVerify, onCancelVerify,
}: {
  source: Source
  testing: boolean
  testResult: string | null
  onToggle: () => void
  onTest: () => void
  onDelete: () => void
  verifying: boolean
  verifyCountdown: number
  verifyResult: 'success' | 'timeout' | null
  onVerify: () => void
  onCancelVerify: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: source.id })

  const st = source.status ?? 'unknown'
  const stale = isStale(source.last_seen)

  return (
    <motion.div
      ref={setNodeRef}
      layout
      className="source-card"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        background: isDragging ? 'rgba(59,130,246,0.06)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${isDragging ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        boxShadow: isDragging ? '0 0 24px rgba(59,130,246,0.2)' : undefined,
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="drag-handle"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, background: 'rgba(255,255,255,0.02)',
            borderRight: '1px solid var(--border)',
            cursor: 'grab', flexShrink: 0,
          }}
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </div>

        {/* Card body */}
        <div style={{ flex: 1, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Header row: name + status pill + delete (hover) + toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Status dot */}
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: STATUS_DOT[st],
              boxShadow: st === 'online' ? `0 0 6px ${STATUS_DOT[st]}` : 'none',
            }} />

            {/* Name */}
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-head)', flex: 1 }}>
              {source.name}
            </span>

            {/* No data yet badge */}
            {!source.last_seen && (
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: 'var(--amber)', background: 'rgba(245,158,11,0.1)',
                border: '1px solid rgba(245,158,11,0.25)',
                borderRadius: 4, padding: '2px 6px',
                animation: 'pulse-opacity 2s ease-in-out infinite',
              }}>No data yet</span>
            )}

            {/* Status pill */}
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '3px 10px', borderRadius: 20,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color:      STATUS_TEXT[st],
              background: STATUS_PILL_BG[st],
              border:     `1px solid ${STATUS_PILL_BORDER[st]}`,
            }}>
              {st}
            </span>

            {/* Delete — appears on card hover via CSS */}
            <button
              className="card-delete"
              onClick={onDelete}
              title="Remove source"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 6,
                background: 'transparent',
                border: '1px solid rgba(239,68,68,0.2)',
                color: 'var(--red)', cursor: 'pointer',
                opacity: 0, transition: 'opacity 0.15s, background 0.15s',
                flexShrink: 0,
              }}
            >
              <Trash2 size={13} />
            </button>

            {/* Toggle */}
            <label className="toggle" title={source.enabled ? 'Disable adapter' : 'Enable adapter'}>
              <input type="checkbox" checked={source.enabled} onChange={onToggle} />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Metadata 2×2 grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
            {([
              ['Type',      source.type],
              ['Adapter',   source.adapter],
              ['Slug',      source.slug],
              ['Last Seen', relativeTime(source.last_seen)],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <div style={{
                  color: 'var(--text-dim)', fontSize: 10,
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  fontWeight: 500, marginBottom: 3,
                }}>{k}</div>
                <div
                  className="mono"
                  style={{
                    color: k === 'Last Seen' && stale ? 'var(--red)' : 'var(--text-head)',
                    fontSize: 12,
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>

          {/* Test / verify result banners */}
          {testResult && (
            <div style={{
              fontSize: 11, padding: '6px 12px', borderRadius: 'var(--radius)',
              background: testResult.includes('failed') ? 'var(--red-dim)' : 'var(--green-dim)',
              color:      testResult.includes('failed') ? 'var(--red)'     : 'var(--green)',
              border:     `1px solid ${testResult.includes('failed') ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
            }}>
              {testResult}
            </div>
          )}
          {verifyResult === 'success' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11, padding: '6px 12px', borderRadius: 'var(--radius)',
              background: 'var(--green-dim)', color: 'var(--green)',
              border: '1px solid rgba(34,197,94,0.2)',
            }}>
              <CheckCircle size={12} /> Webhook received! Connection verified.
            </div>
          )}
          {verifyResult === 'timeout' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11, padding: '6px 12px', borderRadius: 'var(--radius)',
              background: 'rgba(245,158,11,0.08)', color: 'var(--amber)',
              border: '1px solid rgba(245,158,11,0.25)', flexWrap: 'wrap',
            }}>
              <span style={{ flex: 1 }}>No webhook received — check your integration settings</span>
              <button className="btn" onClick={onVerify} style={{ padding: '1px 8px', fontSize: 10 }}>Retry</button>
            </div>
          )}

          {/* Actions */}
          {verifying ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Radio size={13} style={{ animation: 'pulse-opacity 1s ease-in-out infinite', color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                Listening for webhook… {verifyCountdown}s
              </span>
              <button className="btn" onClick={onCancelVerify} title="Cancel" style={{ padding: '0 8px' }}>
                <X size={12} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              {/* Send Test — full-width ghost → blue on hover */}
              <button
                className="btn-test"
                onClick={onTest}
                disabled={testing}
                style={{
                  flex: 1,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '7px 0',
                  borderRadius: 'var(--radius)',
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-muted)',
                  fontSize: 12, fontWeight: 500,
                  cursor: testing ? 'wait' : 'pointer',
                  transition: 'background 0.2s, border-color 0.2s, color 0.2s',
                }}
              >
                {testing
                  ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                  : <Zap size={13} />}
                {testing ? 'Testing…' : 'Send Test'}
              </button>

              {/* Verify (if no data yet) */}
              {!source.last_seen && (
                <button
                  className="btn"
                  onClick={onVerify}
                  title="Listen for a real incoming webhook"
                  style={{ gap: 5, padding: '0 12px', color: 'var(--accent)', fontSize: 12 }}
                >
                  <Radio size={12} /> Verify
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

// ─── Adapter info row ─────────────────────────────────────────────────────────
function AdapterInfoRow({ icon, name, note, url }: { icon: React.ReactNode; name: string; note: string; url: string }) {
  const copy = () => {
    navigator.clipboard.writeText(url)
    toast.success('Copied to clipboard')
  }
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,0.2)',
      borderRadius: 'var(--radius)', padding: '10px 14px',
      fontSize: 11, color: 'var(--text-muted)',
    }}>
      <span style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ color: 'var(--text-head)' }}>{name}</strong> — {note}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <span className="mono" style={{ color: 'var(--accent)', fontSize: 11, wordBreak: 'break-all' }}>{url}</span>
          <button className="btn" onClick={copy} title="Copy URL" style={{ padding: '2px 6px', flexShrink: 0 }}>
            <Copy size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Sources() {
  const [sources, setSources]       = useState<Source[]>([])
  const [loading, setLoading]       = useState(true)
  const [testing, setTesting]       = useState<number | null>(null)
  const [testResults, setTestResults] = useState<Record<number, string>>({})
  const [showWizard, setShowWizard] = useState(false)
  const [showGuide, setShowGuide]   = useState(false)
  const [verifying, setVerifying]   = useState<number | null>(null)
  const [verifyCountdown, setVerifyCountdown] = useState(0)
  const [verifyResult, setVerifyResult] = useState<Record<number, 'success' | 'timeout'>>({})
  const verifyIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const load = () => getSources().then(setSources).finally(() => setLoading(false))
  useEffect(() => { load() }, [])
  useEffect(() => () => { if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current) }, [])

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    setSources(prev => {
      const oldIdx = prev.findIndex(s => s.id === active.id)
      const newIdx = prev.findIndex(s => s.id === over.id)
      return arrayMove(prev, oldIdx, newIdx)
    })
  }

  const toggleEnabled = async (s: Source) => {
    try {
      const updated = await updateSource(s.id, { enabled: !s.enabled })
      setSources(prev => prev.map(x => x.id === s.id ? updated : x))
      toast.success(`${s.name} ${updated.enabled ? 'enabled' : 'disabled'}`)
    } catch { /* toast from interceptor */ }
  }

  const handleDelete = async (s: Source) => {
    if (!confirm(`Remove "${s.name}"? This cannot be undone.`)) return
    try {
      await deleteSource(s.id)
      setSources(prev => prev.filter(x => x.id !== s.id))
      toast.success(`${s.name} removed`)
    } catch { /* toast from interceptor */ }
  }

  const cancelVerify = () => {
    if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
    setVerifying(null)
  }

  const startVerify = (s: Source) => {
    if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
    setVerifying(s.id)
    setVerifyCountdown(60)
    setVerifyResult(prev => { const n = { ...prev }; delete n[s.id]; return n })

    const snapshot = s.last_seen
    const deadline = Date.now() + 60_000

    verifyIntervalRef.current = setInterval(async () => {
      const updated = await getSources()
      const current = updated.find(x => x.id === s.id)
      if (current?.last_seen !== snapshot) {
        clearInterval(verifyIntervalRef.current!)
        setSources(updated)
        setVerifying(null)
        setVerifyResult(prev => ({ ...prev, [s.id]: 'success' }))
        setTimeout(() => setVerifyResult(prev => { const n = { ...prev }; delete n[s.id]; return n }), 5000)
        return
      }
      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      if (remaining <= 0) {
        clearInterval(verifyIntervalRef.current!)
        setVerifying(null)
        setVerifyResult(prev => ({ ...prev, [s.id]: 'timeout' }))
        return
      }
      setVerifyCountdown(remaining)
    }, 2000)
  }

  const runTest = async (s: Source) => {
    setTesting(s.id)
    try {
      const res = await testSource(s.id)
      setTestResults(prev => ({ ...prev, [s.id]: `Test alert #${res.alert_id} created` }))
      toast.success(`Test alert sent from ${s.name}`)
    } catch {
      setTestResults(prev => ({ ...prev, [s.id]: 'Test failed' }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Radio size={15} color="var(--accent)" />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-head)' }}>Sources</span>
          <span style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-bright)',
            borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700,
            color: 'var(--text-head)',
          }}>
            {sources.filter(s => s.enabled).length} active
          </span>
        </div>

        {/* Add Adapter — filled gradient button */}
        <button
          onClick={() => setShowWizard(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 16px',
            borderRadius: 8,
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            border: '1px solid rgba(59,130,246,0.4)',
            color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(59,130,246,0.25)',
            transition: 'box-shadow 0.2s, opacity 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 6px 20px rgba(59,130,246,0.4)')}
          onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 4px 12px rgba(59,130,246,0.25)')}
        >
          <Plus size={14} /> Add Adapter
        </button>
      </div>

      {/* Setup guide */}
      <div style={{ flexShrink: 0 }}>
        <button
          className="btn"
          onClick={() => setShowGuide(v => !v)}
          style={{ gap: 6, fontSize: 11, padding: '4px 10px', color: 'var(--text-muted)' }}
        >
          <BookOpen size={12} />
          Setup Guide
          {showGuide ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
        {showGuide && (
          <div className="card" style={{ marginTop: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AdapterInfoRow
              icon={<Activity size={13} />}
              name="NinjaRMM"
              note="In NinjaRMM → Administration → Webhooks, add a new webhook and paste this URL:"
              url={`${window.location.origin}/api/ingest/ninjarmm`}
            />
            <AdapterInfoRow
              icon={<Wifi size={13} />}
              name="PingPlotter"
              note="In PingPlotter → Alerts → Alert Notifications, set the webhook URL to:"
              url={`${window.location.origin}/api/ingest/pingplotter`}
            />
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
              fontSize: 11, color: 'var(--text-muted)',
            }}>
              <Shield size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--amber)' }} />
              <span>
                <strong style={{ color: 'var(--text-head)' }}>pfSense</strong> — In Status → System Logs → Settings, set Remote Log Server to{' '}
                <span className="mono" style={{ color: 'var(--accent)' }}>your-server-ip:514</span> (UDP).{' '}
                <span style={{ color: 'var(--amber)' }}>Note: Railway cannot receive UDP — self-hosted deployment required for pfSense.</span>
              </span>
            </div>
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,0.2)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
              fontSize: 11, color: 'var(--text-muted)',
            }}>
              <Globe size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }} />
              <span>
                <strong style={{ color: 'var(--text-head)' }}>Custom Webhook</strong> — After adding a custom adapter, your endpoint will be:{' '}
                <span className="mono" style={{ color: 'var(--accent)' }}>
                  {window.location.origin}/api/ingest/<span style={{ opacity: 0.6 }}>{'{your-slug}'}</span>
                </span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Drag hint */}
      {!loading && sources.length > 1 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <GripVertical size={12} /> Drag adapters to reorder
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 160, borderRadius: 'var(--radius-lg)' }} />
          ))}
        </div>
      )}

      {/* Sortable list */}
      {!loading && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sources.map(s => s.id)} strategy={verticalListSortingStrategy}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sources.map(s => (
                <SourceCard
                  key={s.id}
                  source={s}
                  testing={testing === s.id}
                  testResult={testResults[s.id] ?? null}
                  onToggle={() => toggleEnabled(s)}
                  onTest={() => runTest(s)}
                  onDelete={() => handleDelete(s)}
                  verifying={verifying === s.id}
                  verifyCountdown={verifyCountdown}
                  verifyResult={verifyResult[s.id] ?? null}
                  onVerify={() => startVerify(s)}
                  onCancelVerify={cancelVerify}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Empty state */}
      {!loading && sources.length === 0 && (
        <div className="card" style={{ padding: '48px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <Radio size={32} color="var(--text-dim)" />
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-head)', marginBottom: 5 }}>
              No adapters connected yet
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Follow these steps to start receiving alerts:
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {(['Click Add Adapter', 'Choose your integration', 'Configure & test'] as const).map((label, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-bright)',
                borderRadius: 'var(--radius)', padding: '8px 14px',
                fontSize: 12, color: 'var(--text-muted)',
              }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: 'var(--accent)', color: '#fff',
                  fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>{i + 1}</span>
                {label}
              </div>
            ))}
          </div>
          <button
            onClick={() => setShowWizard(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 20px', borderRadius: 8,
              background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
              border: '1px solid rgba(59,130,246,0.4)',
              color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', boxShadow: '0 4px 12px rgba(59,130,246,0.25)',
            }}
          >
            <Plus size={14} /> Add Adapter
          </button>
        </div>
      )}

      {/* Wizard */}
      <AnimatePresence>
        {showWizard && (
          <AdapterWizard onClose={() => setShowWizard(false)} onComplete={load} />
        )}
      </AnimatePresence>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse-opacity { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .source-card:hover .card-delete { opacity: 1 !important; }
        .btn-test:hover:not(:disabled) {
          background: rgba(59,130,246,0.15) !important;
          border-color: rgba(59,130,246,0.4) !important;
          color: var(--accent) !important;
        }
      `}</style>
    </div>
  )
}
