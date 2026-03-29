import { useState, useEffect, useCallback } from 'react'
import { Bell, Volume2, Send, ShieldOff, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { Rule } from '../types'
import {
  getRules, createRule, updateRule, deleteRule,
  sendTestNotification,
  getMaintenanceStatus, startMaintenance, stopMaintenance,
  type MaintenanceStatus,
} from '../lib/api'
import { notificationService, type NotifPrefs } from '../lib/notifications'

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: 4, color: 'var(--text)', fontSize: 12,
  padding: '5px 10px', outline: 'none', width: '100%',
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const labelStyle: React.CSSProperties = {
  color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: 3, display: 'block',
}

interface RuleFormData {
  name: string
  source_slug: string
  field: string
  operator: string
  value: string
  action: string
  severity_override: string
  notify_telegram: boolean
  notify_email: boolean
  cooldown_minutes: number
  enabled: boolean
}

const BLANK_FORM: RuleFormData = {
  name: '', source_slug: '', field: 'event_type', operator: 'equals', value: '',
  action: 'notify', severity_override: '', notify_telegram: true,
  notify_email: false, cooldown_minutes: 15, enabled: true,
}

export default function Settings() {
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<RuleFormData>(BLANK_FORM)
  const [editId, setEditId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getRules().then(setRules).finally(() => setLoading(false))
  }, [])

  const set = (k: keyof RuleFormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const val = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value
    setForm(prev => ({ ...prev, [k]: val }))
  }

  const handleSave = async () => {
    setSaving(true)
    const data = {
      name: form.name,
      source_slug: form.source_slug || null,
      condition: { field: form.field, operator: form.operator, value: form.value },
      action: form.action,
      severity_override: (form.severity_override || null) as Rule['severity_override'],
      notify_telegram: form.notify_telegram,
      notify_email: form.notify_email,
      cooldown_minutes: Number(form.cooldown_minutes),
      enabled: form.enabled,
    }
    try {
      if (editId !== null) {
        const updated = await updateRule(editId, data)
        setRules(prev => prev.map(r => r.id === editId ? updated : r))
        setEditId(null)
      } else {
        const created = await createRule(data)
        setRules(prev => [...prev, created])
      }
      setForm(BLANK_FORM)
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (r: Rule) => {
    const cond = r.condition as { field: string; operator: string; value: string }
    setForm({
      name: r.name,
      source_slug: r.source_slug ?? '',
      field: cond.field ?? 'event_type',
      operator: cond.operator ?? 'equals',
      value: String(cond.value ?? ''),
      action: r.action,
      severity_override: r.severity_override ?? '',
      notify_telegram: r.notify_telegram,
      notify_email: r.notify_email,
      cooldown_minutes: r.cooldown_minutes,
      enabled: r.enabled,
    })
    setEditId(r.id)
  }

  const handleDelete = async (id: number) => {
    await deleteRule(id)
    setRules(prev => prev.filter(r => r.id !== id))
  }

  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>(() => notificationService.getPrefs())
  const [browserPerm, setBrowserPerm] = useState(() => notificationService.getBrowserPermission())
  const [testingChannel, setTestingChannel] = useState<'telegram' | 'email' | null>(null)

  const [maintenance, setMaintenance] = useState<MaintenanceStatus>({ active: false, until: null, remaining_seconds: 0 })
  const [maintMinutes, setMaintMinutes] = useState(30)
  const [maintLoading, setMaintLoading] = useState(false)

  const refreshMaintenance = useCallback(() => {
    getMaintenanceStatus().then(setMaintenance).catch(() => {})
  }, [])

  useEffect(() => {
    refreshMaintenance()
    const t = setInterval(refreshMaintenance, 10_000)
    return () => clearInterval(t)
  }, [refreshMaintenance])

  const handleMaintenanceStart = async () => {
    setMaintLoading(true)
    try {
      const s = await startMaintenance(maintMinutes)
      setMaintenance(s)
      toast.success(`Maintenance mode active for ${maintMinutes}m — notifications suppressed`)
    } finally {
      setMaintLoading(false)
    }
  }

  const handleMaintenanceStop = async () => {
    setMaintLoading(true)
    try {
      const s = await stopMaintenance()
      setMaintenance(s)
      toast.success('Maintenance mode ended — notifications resumed')
    } finally {
      setMaintLoading(false)
    }
  }

  const updatePref = (key: keyof NotifPrefs, val: boolean) => {
    const updated = { ...notifPrefs, [key]: val }
    setNotifPrefs(updated)
    notificationService.savePrefs(updated)
  }

  const requestPerm = async () => {
    const result = await notificationService.requestBrowserPermission()
    setBrowserPerm(result)
  }

  const handleTestNotif = async (channel: 'telegram' | 'email') => {
    setTestingChannel(channel)
    try {
      const result = await sendTestNotification(channel)
      if (result.success) {
        toast.success(`Test ${channel} notification sent`)
      } else {
        toast.error(`${channel} test failed: ${result.error ?? 'unknown error'}`)
      }
    } catch {
      toast.error(`${channel} not configured — check Settings`)
    } finally {
      setTestingChannel(null)
    }
  }

  const section = (title: string, icon?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, marginTop: 4 }}>
      {icon}{title}
    </div>
  )

  return (
    <div className="settings-layout" style={{ padding: 16, display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>
      {/* Rule builder */}
      <div className="settings-sidebar" style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
        <span style={{ color: 'var(--text-head)', fontWeight: 600, fontSize: 14 }}>
          {editId !== null ? 'Edit Rule' : 'New Rule'}
        </span>

        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={labelStyle}>Rule Name</label>
            <input style={inputStyle} value={form.name} onChange={set('name')} placeholder="e.g. Suppress FW blocks" />
          </div>

          <div>
            <label style={labelStyle}>Source (blank = all)</label>
            <select style={selectStyle} value={form.source_slug} onChange={set('source_slug')}>
              <option value="">All sources</option>
              <option value="pfsense">pfSense</option>
              <option value="ninjarmm">NinjaRMM</option>
              <option value="pingplotter">PingPlotter</option>
            </select>
          </div>

          {section('Condition')}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Field</label>
              <input style={inputStyle} value={form.field} onChange={set('field')} placeholder="event_type" />
            </div>
            <div>
              <label style={labelStyle}>Operator</label>
              <select style={selectStyle} value={form.operator} onChange={set('operator')}>
                <option value="equals">equals</option>
                <option value="not_equals">not equals</option>
                <option value="contains">contains</option>
                <option value="not_contains">not contains</option>
                <option value="greater_than">greater than</option>
                <option value="less_than">less than</option>
                <option value="matches_regex">regex</option>
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Value</label>
            <input style={inputStyle} value={form.value} onChange={set('value')} placeholder="firewall_block" />
          </div>

          {section('Action')}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Action</label>
              <select style={selectStyle} value={form.action} onChange={set('action')}>
                <option value="notify">notify</option>
                <option value="suppress">suppress</option>
                <option value="severity_override">severity override</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Severity Override</label>
              <select style={selectStyle} value={form.severity_override} onChange={set('severity_override')}>
                <option value="">None</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
                <option value="ok">OK</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={form.notify_telegram} onChange={set('notify_telegram')} />
              Telegram
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={form.notify_email} onChange={set('notify_email')} />
              Email
            </label>
          </div>

          <div>
            <label style={labelStyle}>Cooldown (minutes)</label>
            <input style={inputStyle} type="number" value={form.cooldown_minutes} onChange={set('cooldown_minutes')} min={0} />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!form.name || saving}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                background: 'var(--blue)', border: 'none', color: '#fff',
                opacity: (!form.name || saving) ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving…' : editId !== null ? 'Update Rule' : 'Create Rule'}
            </button>
            {editId !== null && (
              <button
                onClick={() => { setEditId(null); setForm(BLANK_FORM) }}
                style={{
                  padding: '6px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                  background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text)',
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* ─ Notification Preferences ─ */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {section('Notifications', <Bell size={11} />)}
          <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Browser permission */}
            {browserPerm !== 'granted' && (
              <div style={{ background: 'var(--amber-dim)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 11, color: 'var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span>Browser notifications {browserPerm === 'denied' ? 'blocked' : 'not enabled'}</span>
                {browserPerm !== 'denied' && <button className="btn" style={{ fontSize: 10, padding: '2px 8px' }} onClick={requestPerm}>Enable</button>}
              </div>
            )}

            {/* Sound */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-head)' }}>
                <Volume2 size={13} color="var(--text-dim)" /> Sound alerts
              </div>
              <label className="toggle"><input type="checkbox" checked={notifPrefs.soundEnabled} onChange={e => updatePref('soundEnabled', e.target.checked)} /><span className="toggle-slider" /></label>
            </div>

            {notifPrefs.soundEnabled && (
              <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(['soundCritical', 'soundWarning', 'soundInfo'] as const).map(key => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                    <span>{key.replace('sound', '')}</span>
                    <label className="toggle"><input type="checkbox" checked={notifPrefs[key]} onChange={e => updatePref(key, e.target.checked)} /><span className="toggle-slider" /></label>
                  </div>
                ))}
              </div>
            )}

            {/* Browser notifs */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-head)' }}>
                <Bell size={13} color="var(--text-dim)" /> Browser notifications
              </div>
              <label className="toggle"><input type="checkbox" checked={notifPrefs.browserEnabled} onChange={e => updatePref('browserEnabled', e.target.checked)} /><span className="toggle-slider" /></label>
            </div>

            {notifPrefs.browserEnabled && (
              <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(['browserCritical', 'browserWarning', 'browserInfo'] as const).map(key => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                    <span>{key.replace('browser', '')}</span>
                    <label className="toggle"><input type="checkbox" checked={notifPrefs[key]} onChange={e => updatePref(key, e.target.checked)} /><span className="toggle-slider" /></label>
                  </div>
                ))}
              </div>
            )}
            {/* Test notification buttons */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)' }}>Send Test</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                  disabled={testingChannel !== null}
                  onClick={() => handleTestNotif('telegram')}
                >
                  <Send size={11} />
                  {testingChannel === 'telegram' ? 'Sending…' : 'Telegram'}
                </button>
                <button
                  className="btn"
                  style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                  disabled={testingChannel !== null}
                  onClick={() => handleTestNotif('email')}
                >
                  <Send size={11} />
                  {testingChannel === 'email' ? 'Sending…' : 'Email'}
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ─ Maintenance Mode ─ */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        {section('Maintenance Mode', maintenance.active ? <ShieldOff size={11} color="var(--amber)" /> : <ShieldCheck size={11} />)}
        <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {maintenance.active ? (
            <div style={{ background: 'var(--amber-dim)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 11, color: 'var(--amber)' }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Notifications suppressed</div>
              <div style={{ color: 'var(--text-muted)' }}>
                {Math.ceil(maintenance.remaining_seconds / 60)}m remaining
                {maintenance.until ? ` · until ${new Date(maintenance.until).toLocaleTimeString()}` : ''}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              Suppress all outbound notifications for a set period (e.g. during maintenance windows).
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!maintenance.active && (
              <select
                className="input"
                style={{ flex: 1, fontSize: 11 }}
                value={maintMinutes}
                onChange={e => setMaintMinutes(Number(e.target.value))}
              >
                {[15, 30, 60, 120, 240].map(m => (
                  <option key={m} value={m}>{m} minutes</option>
                ))}
              </select>
            )}
            {maintenance.active ? (
              <button
                className="btn btn-danger"
                style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                disabled={maintLoading}
                onClick={handleMaintenanceStop}
              >
                <ShieldCheck size={11} />
                {maintLoading ? 'Stopping…' : 'End Maintenance'}
              </button>
            ) : (
              <button
                className="btn"
                style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                disabled={maintLoading}
                onClick={handleMaintenanceStart}
              >
                <ShieldOff size={11} />
                {maintLoading ? 'Starting…' : 'Start Maintenance'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* spacer */}
      <div style={{ display: 'none' }} />

      {/* Rule list */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
        <span style={{ color: 'var(--text-head)', fontWeight: 600, fontSize: 14 }}>Rules ({rules.length})</span>

        {loading ? (
          <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
        ) : rules.length === 0 ? (
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 6, padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13,
          }}>
            No rules defined. Create one to control alert routing and suppression.
          </div>
        ) : (
          rules.map(r => (
            <div
              key={r.id}
              style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '10px 14px',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
                opacity: r.enabled ? 1 : 0.5,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--text-head)', fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{r.name}</div>
                <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  {r.source_slug ? `[${r.source_slug}] ` : ''}
                  <span className="mono">{(r.condition as any).field} {(r.condition as any).operator} "{(r.condition as any).value}"</span>
                  {' → '}
                  <span style={{ color: 'var(--text)' }}>{r.action}</span>
                  {r.severity_override && <span style={{ color: 'var(--amber)' }}> → {r.severity_override}</span>}
                  {' · '}cooldown {r.cooldown_minutes}m
                </div>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => startEdit(r)} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 3,
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  color: 'var(--text)', cursor: 'pointer',
                }}>Edit</button>
                <button onClick={() => handleDelete(r.id)} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 3,
                  background: 'var(--red-dim)', border: '1px solid var(--red)',
                  color: 'var(--red)', cursor: 'pointer',
                }}>Delete</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
