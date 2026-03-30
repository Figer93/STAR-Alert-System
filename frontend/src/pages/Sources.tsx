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
import { GripVertical, Plus, Radio, Zap, Loader2, Trash2, ChevronDown, ChevronUp, Copy, BookOpen, Activity, Wifi, Shield, Globe } from 'lucide-react'
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

const STATUS_COLOUR: Record<string, string> = {
  online: 'var(--green)', offline: 'var(--red)', unknown: 'var(--text-dim)',
}
const STATUS_GLOW: Record<string, string> = {
  online: '0 0 7px var(--green)', offline: '0 0 7px var(--red)', unknown: 'none',
}

// ─── Sortable source card ────────────────────────────────────────────────────
function SourceCard({
  source, testing, testResult, onToggle, onTest, onDelete,
}: {
  source: Source
  testing: boolean
  testResult: string | null
  onToggle: () => void
  onTest: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: source.id })

  return (
    <motion.div
      ref={setNodeRef}
      layout
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        background: 'var(--bg-surface)',
        border: `1px solid ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        boxShadow: isDragging ? 'var(--glow-accent)' : undefined,
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
            width: 36, background: 'var(--bg-raised)',
            borderRight: '1px solid var(--border)',
            cursor: 'grab', flexShrink: 0,
          }}
          title="Drag to reorder"
        >
          <GripVertical size={15} />
        </div>

        {/* Card body */}
        <div style={{ flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: STATUS_COLOUR[source.status],
                boxShadow: STATUS_GLOW[source.status],
              }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-head)' }}>{source.name}</span>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
                color: STATUS_COLOUR[source.status], textTransform: 'uppercase',
              }}>
                {source.status}
              </span>
            </div>

            {/* Toggle */}
            <label className="toggle" title={source.enabled ? 'Disable adapter' : 'Enable adapter'}>
              <input type="checkbox" checked={source.enabled} onChange={onToggle} />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Meta grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
            {([
              ['Type',     source.type],
              ['Adapter',  source.adapter],
              ['Last seen', relativeTime(source.last_seen)],
              ['Slug',     source.slug],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                <div style={{ color: 'var(--text-head)', fontSize: 12 }} className="mono">{v}</div>
              </div>
            ))}
          </div>

          {/* Test result */}
          {testResult && (
            <div style={{
              fontSize: 11, padding: '5px 10px', borderRadius: 'var(--radius-sm)',
              background: testResult.includes('failed') ? 'var(--red-dim)' : 'var(--green-dim)',
              color:      testResult.includes('failed') ? 'var(--red)'     : 'var(--green)',
              border:     `1px solid ${testResult.includes('failed') ? 'rgba(255,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
            }}>
              {testResult}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn"
              onClick={onTest}
              disabled={testing}
              style={{ gap: 6, flex: 1, justifyContent: 'center' }}
            >
              {testing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={12} />}
              {testing ? 'Testing…' : 'Send Test'}
            </button>
            <button
              className="btn"
              onClick={onDelete}
              title="Remove source"
              style={{ padding: '0 10px', color: 'var(--red)' }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

// ─── Adapter info row (setup guide) ─────────────────────────────────────────
function AdapterInfoRow({ icon, name, note, url }: { icon: React.ReactNode; name: string; note: string; url: string }) {
  const copy = () => {
    navigator.clipboard.writeText(url)
    toast.success('Copied to clipboard')
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-sm)', padding: '9px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
      <span style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ color: 'var(--text-head)' }}>{name}</strong> — {note}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <span className="mono" style={{ color: 'var(--accent)', fontSize: 11, wordBreak: 'break-all' }}>{url}</span>
          <button
            className="btn"
            onClick={copy}
            title="Copy URL"
            style={{ padding: '2px 6px', flexShrink: 0 }}
          >
            <Copy size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function Sources() {
  const [sources, setSources]       = useState<Source[]>([])
  const [loading, setLoading]       = useState(true)
  const [testing, setTesting]       = useState<number | null>(null)
  const [testResults, setTestResults] = useState<Record<number, string>>({})
  const [showWizard, setShowWizard] = useState(false)
  const [showGuide, setShowGuide]   = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const load = () => getSources().then(setSources).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

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
          <Radio size={16} color="var(--accent)" />
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-head)' }}>Sources</span>
          <span style={{
            background: 'var(--bg-raised)', border: '1px solid var(--border-bright)',
            borderRadius: 10, padding: '1px 7px', fontSize: 11, color: 'var(--text-dim)',
          }}>
            {sources.filter(s => s.enabled).length} active
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => setShowWizard(true)} style={{ gap: 7 }}>
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
            {/* NinjaRMM */}
            <AdapterInfoRow
              icon={<Activity size={13} />}
              name="NinjaRMM"
              note="In NinjaRMM → Administration → Webhooks, add a new webhook and paste this URL:"
              url={`${window.location.origin}/api/ingest/ninjarmm`}
            />
            {/* PingPlotter */}
            <AdapterInfoRow
              icon={<Wifi size={13} />}
              name="PingPlotter"
              note="In PingPlotter → Alerts → Alert Notifications, set the webhook URL to:"
              url={`${window.location.origin}/api/ingest/pingplotter`}
            />
            {/* pfSense */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 'var(--radius-sm)', padding: '9px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
              <Shield size={13} style={{ flexShrink: 0, marginTop: 1, color: '#f59e0b' }} />
              <span><strong style={{ color: 'var(--text-head)' }}>pfSense</strong> — In Status → System Logs → Settings, set Remote Log Server to <span className="mono" style={{ color: 'var(--accent)' }}>your-server-ip:514</span> (UDP). <span style={{ color: '#f59e0b' }}>Note: Railway cannot receive UDP — self-hosted deployment required for pfSense.</span></span>
            </div>
            {/* Custom */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--accent-dim)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-sm)', padding: '9px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
              <Globe size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent)' }} />
              <span><strong style={{ color: 'var(--text-head)' }}>Custom Webhook</strong> — After adding a custom adapter, your endpoint will be: <span className="mono" style={{ color: 'var(--accent)' }}>{window.location.origin}/api/ingest/<span style={{ opacity: 0.6 }}>{'{your-slug}'}</span></span></span>
            </div>
          </div>
        )}
      </div>

      {/* Hint */}
      {!loading && sources.length > 1 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <GripVertical size={12} /> Drag adapters to reorder
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 130, borderRadius: 'var(--radius)' }} />
          ))}
        </div>
      )}

      {/* Sortable list */}
      {!loading && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sources.map(s => s.id)} strategy={verticalListSortingStrategy}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sources.map(s => (
                <SourceCard
                  key={s.id}
                  source={s}
                  testing={testing === s.id}
                  testResult={testResults[s.id] ?? null}
                  onToggle={() => toggleEnabled(s)}
                  onTest={() => runTest(s)}
                  onDelete={() => handleDelete(s)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Empty state */}
      {!loading && sources.length === 0 && (
        <div className="card" style={{ padding: '36px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <Radio size={28} color="var(--text-dim)" />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-head)', marginBottom: 4 }}>No adapters connected yet</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Follow these steps to start receiving alerts:</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {(['Click Add Adapter', 'Choose your integration', 'Configure & test'] as const).map((label, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--bg-raised)', border: '1px solid var(--border-bright)', borderRadius: 'var(--radius)', padding: '7px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
                {label}
              </div>
            ))}
          </div>
          <button className="btn btn-primary" onClick={() => setShowWizard(true)} style={{ gap: 7, marginTop: 2 }}>
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

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
