import { useCallback, useEffect, useState } from 'react'
import { SlidersHorizontal, Plus, Trash2, Check, AlertTriangle, RefreshCw } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SettingItem {
  key:        string
  value:      string
  updated_at: string | null
}

interface FpingTarget {
  id:         string
  name:       string
  ip:         string
  type:       string
  created_at: string | null
}

// ── Constants ──────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api/network'

const SETTING_META: Record<string, { label: string; desc: string; unit?: string; type: 'number' | 'time' }> = {
  wan_packet_loss_threshold_pct: {
    label: 'WAN packet loss threshold',
    desc:  'Alert when WAN packet loss exceeds this value.',
    unit:  '%',
    type:  'number',
  },
  internal_latency_threshold_ms: {
    label: 'Internal latency threshold',
    desc:  'Alert when gateway RTT exceeds this value.',
    unit:  'ms',
    type:  'number',
  },
  port_error_threshold: {
    label: 'Port error count threshold',
    desc:  'Alert when switch port errors in 24 h exceed this count.',
    unit:  'errors',
    type:  'number',
  },
  traffic_anomaly_multiplier: {
    label: 'Traffic anomaly multiplier',
    desc:  'Flag flows that are this many times the mean as anomalous.',
    unit:  '×',
    type:  'number',
  },
  business_hours_start: {
    label: 'Business hours start',
    desc:  'Used for after-hours anomaly weighting.',
    type:  'time',
  },
  business_hours_end: {
    label: 'Business hours end',
    desc:  'Used for after-hours anomaly weighting.',
    type:  'time',
  },
}

const TARGET_TYPE_OPTIONS = ['host', 'gateway', 'wan', 'dns']

// ── Helpers ────────────────────────────────────────────────────────────────────

function inputStyle(focused = false): React.CSSProperties {
  return {
    background: 'var(--bg-base)',
    border: `1px solid ${focused ? 'var(--blue)' : 'var(--border)'}`,
    color: 'var(--text-primary)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 13,
    colorScheme: 'dark' as const,
    width: '100%',
    boxSizing: 'border-box',
  }
}

// ── Settings form ──────────────────────────────────────────────────────────────

function SettingsForm() {
  const [settings, setSettings] = useState<SettingItem[]>([])
  const [draft, setDraft]       = useState<Record<string, string>>({})
  const [saving, setSaving]     = useState(false)
  const [saveOk, setSaveOk]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${BASE}/settings`)
      .then(r => r.ok ? r.json() as Promise<SettingItem[]> : Promise.reject(`HTTP ${r.status}`))
      .then(data => {
        setSettings(data)
        const d: Record<string, string> = {}
        data.forEach(s => { d[s.key] = s.value })
        setDraft(d)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${BASE}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const updated: SettingItem[] = await res.json()
      setSettings(updated)
      setSaveOk(true)
      setTimeout(() => setSaveOk(false), 2500)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = settings.some(s => draft[s.key] !== s.value)

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16 }}>Loading settings…</div>
  }

  return (
    <section>
      <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-head)', marginBottom: 4 }}>Alert Thresholds</h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>
        Changes take effect on the next health-check cycle (every 60 s).
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {Object.entries(SETTING_META).map(([key, meta]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <label style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', display: 'block', marginBottom: 3 }}>
                {meta.label}
                {meta.unit && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 5, fontSize: 11 }}>({meta.unit})</span>}
              </label>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>{meta.desc}</p>
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <input
                type={meta.type}
                value={draft[key] ?? ''}
                onChange={e => setDraft(prev => ({ ...prev, [key]: e.target.value }))}
                min={meta.type === 'number' ? 0 : undefined}
                style={inputStyle()}
              />
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ marginTop: 16, color: 'var(--red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          onClick={save}
          disabled={saving || !hasChanges}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 20px',
            background: saveOk ? 'var(--green)' : hasChanges ? 'var(--blue)' : 'var(--bg-raised)',
            color: hasChanges || saveOk ? '#fff' : 'var(--text-muted)',
            border: 'none', borderRadius: 7, cursor: hasChanges && !saving ? 'pointer' : 'default',
            fontSize: 13, fontWeight: 600, transition: 'background 0.2s',
          }}
        >
          {saveOk ? <><Check size={13} /> Saved</> : saving ? 'Saving…' : 'Save changes'}
        </button>
        {hasChanges && !saving && (
          <button
            onClick={load}
            style={{
              padding: '8px 14px',
              background: 'none', border: '1px solid var(--border)',
              color: 'var(--text-muted)', borderRadius: 7, cursor: 'pointer', fontSize: 13,
            }}
          >
            Reset
          </button>
        )}
      </div>
    </section>
  )
}

// ── Targets table ─────────────────────────────────────────────────────────────

function TargetsTable() {
  const [targets, setTargets]   = useState<FpingTarget[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [adding, setAdding]     = useState(false)
  const [newName, setNewName]   = useState('')
  const [newIp, setNewIp]       = useState('')
  const [newType, setNewType]   = useState('host')
  const [addError, setAddError] = useState<string | null>(null)
  const [saving, setSaving]     = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${BASE}/targets`)
      .then(r => r.ok ? r.json() as Promise<FpingTarget[]> : Promise.reject(`HTTP ${r.status}`))
      .then(setTargets)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    setAddError(null)
    if (!newName.trim()) { setAddError('Name is required.'); return }
    if (!newIp.trim())   { setAddError('IP address is required.'); return }
    setSaving(true)
    try {
      const res = await fetch(`${BASE}/targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), ip: newIp.trim(), type: newType }),
      })
      if (res.status === 409) { setAddError('A target with that IP already exists.'); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const created: FpingTarget = await res.json()
      setTargets(prev => [...prev, created])
      setNewName(''); setNewIp(''); setNewType('host')
      setAdding(false)
    } catch (e) {
      setAddError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch(`${BASE}/targets/${id}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) {
        setTargets(prev => prev.filter(t => t.id !== id))
      }
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>Monitored Targets</h2>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, marginBottom: 0 }}>
            The collector probes these IPs via ICMP every 30 s. Changes are picked up within 60 s.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={load}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'none', border: '1px solid var(--border)',
              color: 'var(--text-muted)', borderRadius: 6,
              padding: '6px 12px', fontSize: 12, cursor: 'pointer',
            }}
          >
            <RefreshCw size={11} /> Refresh
          </button>
          <button
            onClick={() => setAdding(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'var(--blue)', border: 'none',
              color: '#fff', borderRadius: 6,
              padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <Plus size={13} /> Add target
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      {/* Add row */}
      {adding && (
        <div style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--blue)',
          borderRadius: 8, padding: '14px 16px', marginBottom: 12,
        }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-head)', marginBottom: 12 }}>New target</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 160px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Gateway"
                style={inputStyle()}
              />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>IP address</label>
              <input
                value={newIp}
                onChange={e => setNewIp(e.target.value)}
                placeholder="e.g. 192.168.1.1"
                style={inputStyle()}
              />
            </div>
            <div style={{ flex: '0 0 130px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Type</label>
              <select
                value={newType}
                onChange={e => setNewType(e.target.value)}
                style={{ ...inputStyle(), colorScheme: 'dark' }}
              >
                {TARGET_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          {addError && (
            <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{addError}</p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              onClick={handleAdd}
              disabled={saving}
              style={{
                padding: '7px 16px', background: 'var(--blue)', color: '#fff',
                border: 'none', borderRadius: 6, cursor: saving ? 'wait' : 'pointer',
                fontSize: 12, fontWeight: 600, opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
            <button
              onClick={() => { setAdding(false); setAddError(null) }}
              style={{
                padding: '7px 14px', background: 'none',
                border: '1px solid var(--border)', color: 'var(--text-muted)',
                borderRadius: 6, cursor: 'pointer', fontSize: 12,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '12px 0' }}>Loading…</div>
      ) : targets.length === 0 ? (
        <div style={{
          background: 'var(--bg-base)',
          border: '1px dashed var(--border)',
          borderRadius: 8,
          padding: '32px 20px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 13,
        }}>
          No targets yet. Click "Add target" to start monitoring an IP via ICMP.
        </div>
      ) : (
        <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Name', 'IP', 'Type', 'Added', ''].map(h => (
                  <th key={h} style={{
                    padding: '9px 14px', textAlign: 'left', fontSize: 11,
                    fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {targets.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{t.ip}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.type}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
                    {t.created_at ? new Date(t.created_at).toLocaleDateString('en-GB') : '—'}
                  </td>
                  <td style={{ padding: '9px 14px', textAlign: 'right' }}>
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deletingId === t.id}
                      title="Remove target"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: deletingId === t.id ? 'var(--text-muted)' : 'var(--red)',
                        padding: '2px 6px', borderRadius: 4,
                        opacity: deletingId === t.id ? 0.4 : 1,
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function NetworkSettings() {
  return (
    <div style={{ padding: '28px 32px', maxWidth: 860, margin: '0 auto' }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', border: '1px solid var(--border-bright)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <SlidersHorizontal size={17} color="var(--accent)" />
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>Network Settings</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, marginBottom: 0 }}>
            Alert thresholds and monitored targets. Keyboard shortcut: <kbd style={{ fontFamily: 'monospace', background: 'var(--bg-raised)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 11 }}>G</kbd> then <kbd style={{ fontFamily: 'monospace', background: 'var(--bg-raised)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 11 }}>S</kbd>
          </p>
        </div>
      </div>

      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '24px 28px',
        marginBottom: 24,
      }}>
        <SettingsForm />
      </div>

      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '24px 28px',
      }}>
        <TargetsTable />
      </div>
    </div>
  )
}
