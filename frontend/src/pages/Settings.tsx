import { useState, useEffect, useCallback } from 'react'
import { Bell, Volume2, Send, ShieldOff, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import type { Rule } from '../types'
import {
  getRules, createRule, updateRule, deleteRule,
  sendTestNotification,
  getMaintenanceStatus, startMaintenance, stopMaintenance,
  getChannelSettings, updateChannelSettings,
  type MaintenanceStatus,
  type NotificationChannelSettings,
} from '../lib/api'
import { notificationService, type NotifPrefs } from '../lib/notifications'

// ── Styles ────────────────────────────────────────────────────────────────────

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
const sectionLabel = (title: string, icon?: React.ReactNode) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, marginTop: 4 }}>
    {icon}{title}
  </div>
)

// ── Severity filter helpers ───────────────────────────────────────────────────

const SEVERITIES = ['critical', 'warning', 'info', 'ok'] as const
type Severity = typeof SEVERITIES[number]

const SEVERITY_COLOURS: Record<Severity, string> = {
  critical: 'var(--red)',
  warning: 'var(--amber)',
  info: 'var(--blue)',
  ok: 'var(--green)',
}

const parseSeverityFilter = (filter: string): Record<Severity, boolean> => {
  if (!filter) return { critical: true, warning: true, info: true, ok: true }
  const set = new Set(filter.split(',').map(s => s.trim()).filter(Boolean))
  return {
    critical: set.has('critical'),
    warning:  set.has('warning'),
    info:     set.has('info'),
    ok:       set.has('ok'),
  }
}

const serializeSeverityFilter = (checks: Record<Severity, boolean>): string =>
  SEVERITIES.filter(s => checks[s]).join(',')

// ── Placeholder reference ─────────────────────────────────────────────────────

const PLACEHOLDER_DOCS: [string, string][] = [
  ['{severity}',       'CRITICAL'],
  ['{severity_lower}', 'critical'],
  ['{severity_emoji}', '🔴'],
  ['{source}',         'pfSense'],
  ['{title}',          'Alert title'],
  ['{message}',        'Alert message body'],
  ['{time}',           '14:23:45 UTC'],
  ['{date}',           '2026-03-31'],
  ['{datetime}',       '2026-03-31 14:23:45 UTC'],
  ['{count}',          '3'],
]

// ── RulesPanel ────────────────────────────────────────────────────────────────

interface RulesPanelProps {
  rules: Rule[]
  loading: boolean
  onEdit: (r: Rule) => void
  onDelete: (id: number) => void
}

function RulesPanel({ rules, loading, onEdit, onDelete }: RulesPanelProps) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>

  if (rules.length === 0) return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 6, padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13,
    }}>
      No rules defined. Create one to control alert routing and suppression.
    </div>
  )

  return (
    <>
      {rules.map(r => (
        <div
          key={r.id}
          style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 8,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
            opacity: r.enabled ? 1 : 0.5,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: 'var(--text-head)', fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{r.name}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              {r.source_slug ? `[${r.source_slug}] ` : ''}
              <span className="mono">{(r.condition as any).field} {(r.condition as any).operator} &quot;{(r.condition as any).value}&quot;</span>
              {' → '}
              <span style={{ color: 'var(--text)' }}>{r.action}</span>
              {r.severity_override && <span style={{ color: 'var(--amber)' }}> → {r.severity_override}</span>}
              {' · '}cooldown {r.cooldown_minutes}m
            </div>
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => onEdit(r)} style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 3,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              color: 'var(--text)', cursor: 'pointer',
            }}>Edit</button>
            <button onClick={() => onDelete(r.id)} style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 3,
              background: 'var(--red-dim)', border: '1px solid var(--red)',
              color: 'var(--red)', cursor: 'pointer',
            }}>Delete</button>
          </div>
        </div>
      ))}
    </>
  )
}

// ── ChannelSettingsPanel ──────────────────────────────────────────────────────

interface ChannelSettingsPanelProps {
  channel: 'telegram' | 'email'
  settings: NotificationChannelSettings
  onChange: (s: NotificationChannelSettings) => void
  onSave: () => void
  saving: boolean
}

function ChannelSettingsPanel({ channel, settings: s, onChange, onSave, saving }: ChannelSettingsPanelProps) {
  const [placeholderOpen, setPlaceholderOpen] = useState(false)

  const set = <K extends keyof NotificationChannelSettings>(key: K, value: NotificationChannelSettings[K]) =>
    onChange({ ...s, [key]: value })

  const severityChecks = parseSeverityFilter(s.severity_filter)
  const toggleSeverity = (sev: Severity, checked: boolean) => {
    const updated = { ...severityChecks, [sev]: checked }
    set('severity_filter', serializeSeverityFilter(updated))
  }

  const toggleField = (field: string, checked: boolean) =>
    set('field_toggles', { ...s.field_toggles, [field]: checked })

  const defaultMsgPlaceholder = channel === 'telegram'
    ? '{severity_emoji} {severity} — {source}\n{title}\n\n{message}\n\n🕐 {time}  |  ST&R Dashboard'
    : 'HTML body — field toggles below control which sections appear'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Enable + Send resolutions */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {sectionLabel('Channel')}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: 'var(--text-head)' }}>
            {channel === 'telegram' ? 'Telegram notifications' : 'Email notifications'}
          </span>
          <label className="toggle">
            <input type="checkbox" checked={s.enabled} onChange={e => set('enabled', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontSize: 12, color: 'var(--text-head)' }}>Send resolution notifications</span>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>Notify when an alert is resolved</div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={s.send_resolutions} onChange={e => set('send_resolutions', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* Severity filter */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
        {sectionLabel('Severity Filter')}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
          Only send notifications for the selected severity levels.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SEVERITIES.map(sev => (
            <label
              key={sev}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '5px 10px', borderRadius: 4,
                border: `1px solid ${severityChecks[sev] ? SEVERITY_COLOURS[sev] : 'var(--border)'}`,
                background: severityChecks[sev] ? `color-mix(in srgb, ${SEVERITY_COLOURS[sev]} 12%, transparent)` : 'var(--bg-raised)',
                transition: 'all 0.15s',
                fontSize: 12,
                color: severityChecks[sev] ? SEVERITY_COLOURS[sev] : 'var(--text-dim)',
                fontWeight: severityChecks[sev] ? 600 : 400,
              }}
            >
              <input
                type="checkbox"
                checked={severityChecks[sev]}
                onChange={e => toggleSeverity(sev, e.target.checked)}
                style={{ display: 'none' }}
              />
              {sev.charAt(0).toUpperCase() + sev.slice(1)}
            </label>
          ))}
        </div>
      </div>

      {/* Field inclusion */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
        {sectionLabel('Include in Message')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { key: 'source',    label: 'Source name',      desc: 'e.g. "pfSense"' },
            { key: 'message',   label: 'Message body',     desc: 'Alert detail text' },
            { key: 'timestamp', label: 'Timestamp',        desc: 'First seen time' },
            { key: 'count',     label: 'Occurrence count', desc: 'How many times fired' },
          ].map(({ key, label, desc }) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <span style={{ fontSize: 12, color: 'var(--text-head)' }}>{label}</span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>{desc}</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={s.field_toggles[key] !== false}
                  onChange={e => toggleField(key, e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* Message template */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sectionLabel('Message Template')}

        {/* Email subject */}
        {channel === 'email' && (
          <div>
            <label style={labelStyle}>Subject template</label>
            <input
              style={inputStyle}
              type="text"
              value={s.subject_template}
              onChange={e => set('subject_template', e.target.value)}
              placeholder="[{severity}] {source}: {title}"
            />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
              Leave blank to use default: <span className="mono">[{'{severity}'}] {'{source}'}: {'{title}'}</span>
            </div>
          </div>
        )}

        {/* Message body / Telegram template */}
        <div>
          <label style={labelStyle}>
            {channel === 'telegram' ? 'Message template' : 'Email body'}
          </label>
          {channel === 'telegram' ? (
            <textarea
              style={{ ...inputStyle, height: 120, resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }}
              value={s.message_template}
              onChange={e => set('message_template', e.target.value)}
              placeholder={defaultMsgPlaceholder}
            />
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 10px' }}>
              Email body is auto-generated HTML. Use the <strong>Include in Message</strong> toggles above to control which sections appear. Custom HTML templates are not supported.
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
            {channel === 'telegram' ? 'Leave blank to use the default template.' : ''}
          </div>
        </div>

        {/* Resolution template */}
        {s.send_resolutions && (
          <div>
            <label style={labelStyle}>Resolution template</label>
            <textarea
              style={{ ...inputStyle, height: channel === 'telegram' ? 60 : 40, resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }}
              value={s.resolution_template}
              onChange={e => set('resolution_template', e.target.value)}
              placeholder={channel === 'telegram' ? '✅ RESOLVED — {source}\n{title}' : '[RESOLVED] {source}: {title}'}
            />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
              {channel === 'email' ? 'Used as the email subject for resolution notifications.' : 'Leave blank to use default.'}
            </div>
          </div>
        )}

        {/* Placeholder reference */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          <button
            type="button"
            onClick={() => setPlaceholderOpen(o => !o)}
            style={{
              width: '100%', padding: '7px 10px', background: 'var(--bg-raised)',
              border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)',
            }}
          >
            <span>Available placeholders</span>
            {placeholderOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {placeholderOpen && (
            <div style={{ padding: '10px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
              {PLACEHOLDER_DOCS.map(([token, example]) => (
                <div key={token} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
                  <code style={{ color: 'var(--accent)', fontFamily: 'monospace', fontSize: 10, flexShrink: 0 }}>{token}</code>
                  <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{example}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Channel-specific */}
      {channel === 'telegram' && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
          {sectionLabel('Telegram Options')}
          <div>
            <label style={labelStyle}>Parse mode</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['plain', 'html'] as const).map(mode => (
                <label
                  key={mode}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    padding: '5px 12px', borderRadius: 4, fontSize: 12,
                    border: `1px solid ${s.parse_mode === mode ? 'var(--accent)' : 'var(--border)'}`,
                    background: s.parse_mode === mode ? 'var(--accent-dim)' : 'var(--bg-raised)',
                    color: s.parse_mode === mode ? 'var(--accent)' : 'var(--text-dim)',
                    transition: 'all 0.15s',
                  }}
                >
                  <input
                    type="radio"
                    name="parse_mode"
                    value={mode}
                    checked={s.parse_mode === mode}
                    onChange={() => set('parse_mode', mode)}
                    style={{ display: 'none' }}
                  />
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
              Use HTML to include <code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;code&gt;</code> tags in your template.
            </div>
          </div>
        </div>
      )}

      {/* Save */}
      <button
        onClick={onSave}
        disabled={saving}
        style={{
          padding: '8px 0', borderRadius: 4, fontSize: 12, cursor: 'pointer',
          background: 'var(--blue)', border: 'none', color: '#fff',
          opacity: saving ? 0.5 : 1,
          fontWeight: 600,
        }}
      >
        {saving ? 'Saving…' : `Save ${channel === 'telegram' ? 'Telegram' : 'Email'} Settings`}
      </button>
    </div>
  )
}

// ── Rule form ─────────────────────────────────────────────────────────────────

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

// ── Main Settings page ────────────────────────────────────────────────────────

type RightTab = 'rules' | 'telegram' | 'email'

export default function Settings() {
  // Rules state
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<RuleFormData>(BLANK_FORM)
  const [editId, setEditId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Channel settings state
  const [rightTab, setRightTab] = useState<RightTab>('rules')
  const [tgSettings, setTgSettings] = useState<NotificationChannelSettings | null>(null)
  const [emSettings, setEmSettings] = useState<NotificationChannelSettings | null>(null)
  const [channelSaving, setChannelSaving] = useState(false)

  // Other state
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>(() => notificationService.getPrefs())
  const [browserPerm, setBrowserPerm] = useState(() => notificationService.getBrowserPermission())
  const [testingChannel, setTestingChannel] = useState<'telegram' | 'email' | null>(null)
  const [maintenance, setMaintenance] = useState<MaintenanceStatus>({ active: false, until: null, remaining_seconds: 0 })
  const [maintMinutes, setMaintMinutes] = useState(30)
  const [maintLoading, setMaintLoading] = useState(false)

  useEffect(() => {
    getRules().then(setRules).finally(() => setLoading(false))
    getChannelSettings('telegram').then(setTgSettings).catch(() => {})
    getChannelSettings('email').then(setEmSettings).catch(() => {})
  }, [])

  const refreshMaintenance = useCallback(() => {
    getMaintenanceStatus().then(setMaintenance).catch(() => {})
  }, [])

  useEffect(() => {
    refreshMaintenance()
    const t = setInterval(refreshMaintenance, 10_000)
    return () => clearInterval(t)
  }, [refreshMaintenance])

  // ── Rule handlers ──────────────────────────────────────────────────────────

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

  // ── Channel settings handlers ──────────────────────────────────────────────

  const handleChannelSave = async (channel: 'telegram' | 'email') => {
    const current = channel === 'telegram' ? tgSettings : emSettings
    if (!current) return
    setChannelSaving(true)
    try {
      const updated = await updateChannelSettings(channel, {
        enabled:             current.enabled,
        send_resolutions:    current.send_resolutions,
        severity_filter:     current.severity_filter,
        message_template:    current.message_template,
        resolution_template: current.resolution_template,
        field_toggles:       current.field_toggles,
        parse_mode:          current.parse_mode,
        subject_template:    current.subject_template,
      })
      if (channel === 'telegram') setTgSettings(updated)
      else setEmSettings(updated)
      toast.success(`${channel === 'telegram' ? 'Telegram' : 'Email'} settings saved`)
    } catch {
      toast.error(`Failed to save ${channel} settings`)
    } finally {
      setChannelSaving(false)
    }
  }

  // ── Notification prefs / maintenance handlers ──────────────────────────────

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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="settings-layout" style={{ padding: 16, display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>

      {/* ─ Left sidebar: Rule builder + Browser notifs + Maintenance ─ */}
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
              <option value="unifi">UniFi</option>
            </select>
          </div>

          {sectionLabel('Condition')}
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

          {sectionLabel('Action')}
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

        {/* ─ Browser Notifications ─ */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {sectionLabel('Browser & Sound', <Bell size={11} />)}
          <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>

            {browserPerm !== 'granted' && (
              <div style={{ background: 'var(--amber-dim)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 11, color: 'var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span>Browser notifications {browserPerm === 'denied' ? 'blocked' : 'not enabled'}</span>
                {browserPerm !== 'denied' && <button className="btn" style={{ fontSize: 10, padding: '2px 8px' }} onClick={requestPerm}>Enable</button>}
              </div>
            )}

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

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)' }}>Send Test</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" style={{ flex: 1, justifyContent: 'center', fontSize: 11 }} disabled={testingChannel !== null} onClick={() => handleTestNotif('telegram')}>
                  <Send size={11} />{testingChannel === 'telegram' ? 'Sending…' : 'Telegram'}
                </button>
                <button className="btn" style={{ flex: 1, justifyContent: 'center', fontSize: 11 }} disabled={testingChannel !== null} onClick={() => handleTestNotif('email')}>
                  <Send size={11} />{testingChannel === 'email' ? 'Sending…' : 'Email'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ─ Maintenance Mode ─ */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {sectionLabel('Maintenance Mode', maintenance.active ? <ShieldOff size={11} color="var(--amber)" /> : <ShieldCheck size={11} />)}
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
                Suppress all outbound notifications for a set period.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {!maintenance.active && (
                <select className="input" style={{ flex: 1, fontSize: 11 }} value={maintMinutes} onChange={e => setMaintMinutes(Number(e.target.value))}>
                  {[15, 30, 60, 120, 240].map(m => <option key={m} value={m}>{m} minutes</option>)}
                </select>
              )}
              {maintenance.active ? (
                <button className="btn btn-danger" style={{ flex: 1, justifyContent: 'center', fontSize: 11 }} disabled={maintLoading} onClick={handleMaintenanceStop}>
                  <ShieldCheck size={11} />{maintLoading ? 'Stopping…' : 'End Maintenance'}
                </button>
              ) : (
                <button className="btn" style={{ flex: 1, justifyContent: 'center', fontSize: 11 }} disabled={maintLoading} onClick={handleMaintenanceStart}>
                  <ShieldOff size={11} />{maintLoading ? 'Starting…' : 'Start Maintenance'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─ Right panel: tabbed Rules / Telegram / Email ─ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 12, flexShrink: 0 }}>
          {([
            { id: 'rules' as RightTab,    label: `Rules (${rules.length})` },
            { id: 'telegram' as RightTab, label: 'Telegram' },
            { id: 'email' as RightTab,    label: 'Email' },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setRightTab(tab.id)}
              style={{
                padding: '7px 18px', fontSize: 12, cursor: 'pointer',
                background: 'none', border: 'none',
                borderBottom: rightTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                color: rightTab === tab.id ? 'var(--text-head)' : 'var(--text-dim)',
                fontWeight: rightTab === tab.id ? 600 : 400,
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rightTab === 'rules' && (
            <RulesPanel rules={rules} loading={loading} onEdit={startEdit} onDelete={handleDelete} />
          )}
          {rightTab === 'telegram' && tgSettings && (
            <ChannelSettingsPanel
              channel="telegram"
              settings={tgSettings}
              onChange={setTgSettings}
              onSave={() => handleChannelSave('telegram')}
              saving={channelSaving}
            />
          )}
          {rightTab === 'telegram' && !tgSettings && (
            <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>
          )}
          {rightTab === 'email' && emSettings && (
            <ChannelSettingsPanel
              channel="email"
              settings={emSettings}
              onChange={setEmSettings}
              onSave={() => handleChannelSave('email')}
              saving={channelSaving}
            />
          )}
          {rightTab === 'email' && !emSettings && (
            <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>
          )}
        </div>
      </div>
    </div>
  )
}
