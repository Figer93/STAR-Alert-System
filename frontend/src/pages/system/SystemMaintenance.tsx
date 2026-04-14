import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Wrench, Trash2, Plus, Clock } from 'lucide-react'
import {
  getMaintenanceWindows,
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  type MaintenanceWindow,
} from '../../lib/api'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDatetime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** Convert local datetime-local string ("2026-04-14T09:00") to UTC ISO string. */
function localToUtcIso(localDt: string): string {
  if (!localDt) return ''
  return new Date(localDt).toISOString()
}

/** Convert ISO UTC string to datetime-local input value (local time). */
function utcIsoToLocal(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function WindowStatusBadge({ window: w }: { window: MaintenanceWindow }) {
  const now = Date.now()
  const starts = new Date(w.starts_at).getTime()
  const ends   = new Date(w.ends_at).getTime()

  if (w.is_active) {
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--amber)',
        background: 'rgba(245,158,11,0.12)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 4,
        padding: '2px 7px',
      }}>
        Active — alerts suppressed
      </span>
    )
  }
  if (starts > now) {
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '2px 7px',
      }}>
        Upcoming
      </span>
    )
  }
  if (ends < now) {
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '2px 7px',
      }}>
        Expired
      </span>
    )
  }
  return null
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  color: 'var(--text-head)',
  fontSize: 13,
  padding: '6px 10px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-dim)',
  fontWeight: 500,
  marginBottom: 4,
  display: 'block',
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function SystemMaintenance() {
  const [windows, setWindows] = useState<MaintenanceWindow[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [name, setName]       = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt]   = useState('')

  async function load() {
    try {
      const data = await getMaintenanceWindows()
      setWindows(data)
    } catch {
      // error toast already shown by api interceptor
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim() || !startsAt || !endsAt) {
      setError('All fields are required.')
      return
    }
    const startUtc = localToUtcIso(startsAt)
    const endUtc   = localToUtcIso(endsAt)
    if (new Date(endUtc) <= new Date(startUtc)) {
      setError('End time must be after start time.')
      return
    }
    setSubmitting(true)
    try {
      await createMaintenanceWindow({ name: name.trim(), starts_at: startUtc, ends_at: endUtc })
      setName('')
      setStartsAt('')
      setEndsAt('')
      await load()
    } catch {
      // interceptor handles toast
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMaintenanceWindow(id)
      setWindows(prev => prev.filter(w => w.id !== id))
    } catch {
      // interceptor handles toast
    }
  }

  const activeWindow = windows.find(w => w.is_active)

  return (
    <div style={{ padding: '24px 28px', maxWidth: 720 }}>

      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-head)', marginBottom: 4 }}>
          Maintenance Windows
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Schedule windows during which all network alerts and incident creation are suppressed
        </div>
      </div>

      {/* Active window banner */}
      {activeWindow && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.35)',
            borderRadius: 'var(--radius-lg)',
            padding: '12px 16px',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Wrench size={14} style={{ color: 'var(--amber)', flexShrink: 0 }} />
          <div>
            <span style={{ fontSize: 13, color: 'var(--amber)', fontWeight: 600 }}>
              {activeWindow.name}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 8 }}>
              active until {fmtDatetime(activeWindow.ends_at)} — alerts suppressed
            </span>
          </div>
        </motion.div>
      )}

      {/* Create form */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '18px 20px',
          marginBottom: 20,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        }}>
          <Plus size={14} style={{ color: 'var(--text-dim)' }} />
          <span style={{
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.1em', color: 'var(--text-dim)',
          }}>
            Schedule window
          </span>
        </div>

        <form onSubmit={handleCreate}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Window name</label>
              <input
                style={inputStyle}
                type="text"
                placeholder="e.g. Planned network maintenance"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <label style={labelStyle}>Start (local time)</label>
              <input
                style={inputStyle}
                type="datetime-local"
                value={startsAt}
                onChange={e => setStartsAt(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <label style={labelStyle}>End (local time)</label>
              <input
                style={inputStyle}
                type="datetime-local"
                value={endsAt}
                onChange={e => setEndsAt(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: '100%',
                  padding: '7px 16px',
                  background: 'var(--accent)',
                  color: 'var(--text-bright)',
                  border: 'none',
                  borderRadius: 'var(--radius)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{error}</div>
          )}
        </form>
      </motion.div>

      {/* Window list */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
        }}>
          <Clock size={13} style={{ color: 'var(--text-dim)' }} />
          <span style={{
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.1em', color: 'var(--text-dim)',
          }}>
            Windows
          </span>
          <span style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            active + upcoming + last 30 days
          </span>
        </div>

        {loading ? (
          <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
            Loading…
          </div>
        ) : windows.length === 0 ? (
          <div style={{ padding: '24px 18px', textAlign: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
            No maintenance windows scheduled.
          </div>
        ) : (
          windows.map((w, i) => (
            <div
              key={w.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 18px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                background: w.is_active ? 'rgba(245,158,11,0.04)' : undefined,
              }}
            >
              <Wrench
                size={13}
                style={{ color: w.is_active ? 'var(--amber)' : 'var(--text-dim)', flexShrink: 0 }}
              />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, color: 'var(--text-head)', fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {w.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>
                  {fmtDatetime(w.starts_at)} → {fmtDatetime(w.ends_at)}
                </div>
              </div>

              <WindowStatusBadge window={w} />

              <button
                onClick={() => handleDelete(w.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-dim)',
                  padding: 4,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
                title="Delete window"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </motion.div>

    </div>
  )
}
