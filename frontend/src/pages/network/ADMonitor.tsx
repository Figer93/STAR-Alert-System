import { useEffect, useMemo, useState } from 'react'
import { Users } from 'lucide-react'
import { getAdUsers, getAdSummary, type AdUserRow, type AdSummary } from '../../lib/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

const SEVEN_DAYS_MS  = 7  * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function isRecentSignIn(iso: string | null): boolean {
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() < SEVEN_DAYS_MS
}

function isInactive(u: AdUserRow): boolean {
  if (!u.last_sign_in) return true
  return Date.now() - new Date(u.last_sign_in).getTime() > THIRTY_DAYS_MS
}

function daysUntilExpiry(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000)
}

function flagEmoji(country: string | null): string {
  if (!country) return ''
  const trimmed = country.trim()
  // ISO 2-letter code → regional indicator emoji
  if (trimmed.length === 2) {
    return trimmed.toUpperCase().split('').map(c =>
      String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1F1E6)
    ).join('')
  }
  // Common full country names
  const map: Record<string, string> = {
    'united kingdom': '🇬🇧', 'england': '🇬🇧',
    'united states': '🇺🇸', 'usa': '🇺🇸',
    'germany': '🇩🇪', 'france': '🇫🇷', 'netherlands': '🇳🇱',
    'belgium': '🇧🇪', 'poland': '🇵🇱', 'spain': '🇪🇸',
    'italy': '🇮🇹', 'india': '🇮🇳', 'china': '🇨🇳',
    'russia': '🇷🇺', 'australia': '🇦🇺', 'canada': '🇨🇦',
    'sweden': '🇸🇪', 'norway': '🇳🇴', 'denmark': '🇩🇰',
    'finland': '🇫🇮', 'ireland': '🇮🇪', 'switzerland': '🇨🇭',
    'austria': '🇦🇹', 'portugal': '🇵🇹', 'romania': '🇷🇴',
    'ukraine': '🇺🇦', 'turkey': '🇹🇷', 'israel': '🇮🇱',
    'south africa': '🇿🇦', 'brazil': '🇧🇷', 'mexico': '🇲🇽',
    'japan': '🇯🇵', 'south korea': '🇰🇷', 'singapore': '🇸🇬',
    'new zealand': '🇳🇿', 'uae': '🇦🇪', 'united arab emirates': '🇦🇪',
  }
  return map[trimmed.toLowerCase()] ?? '🌐'
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = 'all' | 'no_mfa' | 'inactive' | 'disabled' | 'deleted' | 'foreign' | 'pwd_expiring'

const TABS: { id: Tab; label: string }[] = [
  { id: 'all',          label: 'All'          },
  { id: 'no_mfa',       label: 'No MFA'       },
  { id: 'inactive',     label: 'Inactive'     },
  { id: 'disabled',     label: 'Disabled'     },
  { id: 'deleted',      label: 'Deleted'      },
  { id: 'foreign',      label: 'Foreign'      },
  { id: 'pwd_expiring', label: 'Pwd Expiring' },
]

function filterUsers(users: AdUserRow[], tab: Tab): AdUserRow[] {
  switch (tab) {
    case 'no_mfa':
      return users.filter(u => !u.is_deleted && u.account_enabled === true && u.mfa_registered === false)
    case 'inactive':
      return users.filter(u => !u.is_deleted && u.account_enabled === true && isInactive(u))
    case 'disabled':
      return users.filter(u => !u.is_deleted && u.account_enabled === false)
    case 'deleted':
      return users.filter(u => u.is_deleted)
    case 'foreign':
      return users.filter(u => !u.is_deleted && u.is_foreign_signin === true)
    case 'pwd_expiring': {
      const thirtyDaysFromNow = Date.now() + THIRTY_DAYS_MS
      return users.filter(u => {
        if (!u.password_expires_at || u.is_deleted || !u.account_enabled) return false
        return new Date(u.password_expires_at).getTime() < thirtyDaysFromNow
      })
    }
    default:
      return users
  }
}

// ── Badge components ──────────────────────────────────────────────────────────

function StatusBadge({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) {
    return (
      <span style={{
        display: 'inline-block', padding: '2px 10px', borderRadius: 6,
        fontSize: 12, fontWeight: 600,
        background: 'rgba(100,100,100,0.15)', border: '1px solid rgba(100,100,100,0.3)',
        color: 'var(--text-muted)',
      }}>
        Unknown
      </span>
    )
  }
  return enabled ? (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 6,
      fontSize: 12, fontWeight: 600,
      background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)',
      color: '#22c55e',
    }}>
      Enabled
    </span>
  ) : (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 6,
      fontSize: 12, fontWeight: 600,
      background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
      color: '#ef4444',
    }}>
      Disabled
    </span>
  )
}

function MfaBadge({ registered }: { registered: boolean | null }) {
  if (registered === null) {
    return <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>--</span>
  }
  return registered ? (
    <span style={{ color: '#22c55e', fontSize: 14, fontWeight: 700 }}>✓</span>
  ) : (
    <span style={{ color: '#ef4444', fontSize: 14, fontWeight: 700 }}>✗</span>
  )
}

function PwdExpiresBadge({ iso }: { iso: string | null }) {
  if (!iso) {
    return <span style={{ color: '#22c55e', fontWeight: 600, fontSize: 12 }}>Never</span>
  }
  const days = daysUntilExpiry(iso)
  if (days === null) return <span style={{ color: 'var(--text-dim)' }}>--</span>

  if (days < 0) {
    return (
      <span style={{
        color: '#ef4444', fontWeight: 600, fontSize: 12,
        background: 'rgba(239,68,68,0.1)', padding: '1px 6px', borderRadius: 4,
      }}>
        Expired
      </span>
    )
  }
  if (days <= 7) {
    return (
      <span style={{
        color: '#ef4444', fontWeight: 600, fontSize: 12,
        background: 'rgba(239,68,68,0.1)', padding: '1px 6px', borderRadius: 4,
      }}>
        {fmtDateShort(iso)} ({days}d)
      </span>
    )
  }
  if (days <= 30) {
    return (
      <span style={{
        color: '#eab308', fontWeight: 600, fontSize: 12,
        background: 'rgba(234,179,8,0.1)', padding: '1px 6px', borderRadius: 4,
      }}>
        {fmtDateShort(iso)} ({days}d)
      </span>
    )
  }
  return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtDateShort(iso)}</span>
}

// ── Row style ─────────────────────────────────────────────────────────────────

function rowBorderStyle(u: AdUserRow): React.CSSProperties {
  if (u.is_foreign_signin && u.account_enabled === true) {
    return { borderLeft: '3px solid #ef4444' }
  }
  if (u.account_enabled === false && isRecentSignIn(u.last_sign_in)) {
    return { borderLeft: '3px solid #ef4444' }
  }
  if (u.account_enabled === true && u.mfa_registered === false) {
    return { borderLeft: '3px solid #eab308' }
  }
  return { borderLeft: '3px solid transparent' }
}

// ── Summary card ──────────────────────────────────────────────────────────────

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  )
}

// ── Licence cell ──────────────────────────────────────────────────────────────

function LicenseCell({ names }: { names: string | null }) {
  if (!names) return <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</span>

  const parts = names.split(', ')
  if (parts.length <= 1) {
    return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{names}</span>
  }
  // Truncate with tooltip showing all
  return (
    <span
      title={names}
      style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'default' }}
    >
      {parts[0]}
      <span style={{ color: 'var(--text-dim)' }}> +{parts.length - 1}</span>
    </span>
  )
}

// ── Country cell ──────────────────────────────────────────────────────────────

function CountryCell({ country, isForeign }: { country: string | null; isForeign: boolean }) {
  if (!country) return <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</span>

  const flag = flagEmoji(country)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 12, fontWeight: isForeign ? 600 : 400,
      color: isForeign ? '#ef4444' : 'var(--text-muted)',
      background: isForeign ? 'rgba(239,68,68,0.08)' : 'transparent',
      padding: isForeign ? '1px 6px' : 0,
      borderRadius: isForeign ? 4 : 0,
    }}>
      {flag && <span style={{ fontSize: 14 }}>{flag}</span>}
      {country}
    </span>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ADMonitor() {
  const [users,   setUsers]   = useState<AdUserRow[]>([])
  const [summary, setSummary] = useState<AdSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [tab,     setTab]     = useState<Tab>('all')

  useEffect(() => {
    Promise.all([getAdUsers(), getAdSummary()])
      .then(([u, s]) => {
        setUsers(u)
        setSummary(s)
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load AD Monitor data')
        setLoading(false)
      })
  }, [])

  const filtered = useMemo(() => filterUsers(users, tab), [users, tab])

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1400, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <Users size={22} color="var(--accent)" />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            AD Monitor
          </h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          Azure AD user accounts synced from Microsoft Graph every 15 minutes.
        </p>
      </div>

      {/* Summary cards */}
      {summary && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 16,
          marginBottom: 28,
        }}>
          <SummaryCard label="Total"           value={summary.total}                color="var(--text-primary)" />
          <SummaryCard label="Enabled"         value={summary.enabled}              color="#22c55e" />
          <SummaryCard label="Disabled"        value={summary.disabled}             color={summary.disabled             > 0 ? '#ef4444' : 'var(--text-primary)'} />
          <SummaryCard label="No MFA"          value={summary.no_mfa}               color={summary.no_mfa               > 0 ? '#eab308' : 'var(--text-primary)'} />
          <SummaryCard label="Inactive 30d"    value={summary.inactive_30d}         color={summary.inactive_30d         > 0 ? '#eab308' : 'var(--text-primary)'} />
          <SummaryCard label="Deleted 7d"      value={summary.deleted_7d}           color={summary.deleted_7d           > 0 ? '#ef4444' : 'var(--text-primary)'} />
          <SummaryCard label="Foreign Sign-ins" value={summary.foreign_signin_count} color={summary.foreign_signin_count > 0 ? '#ef4444' : 'var(--text-primary)'} />
          <SummaryCard label="Expiring / 7d"   value={summary.expiring_soon_count}  color={summary.expiring_soon_count  > 0 ? '#eab308' : 'var(--text-primary)'} />
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 20 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              border: '1px solid',
              borderColor:    tab === t.id ? 'var(--accent)'         : 'var(--border)',
              background:     tab === t.id ? 'rgba(99,102,241,0.15)' : 'transparent',
              color:          tab === t.id ? 'var(--accent)'         : 'var(--text-muted)',
              transition:     'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            Loading AD users…
          </div>
        ) : error ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#ef4444', fontSize: 14 }}>
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            {users.length === 0
              ? 'No AD data available yet — sync may not have run.'
              : 'No users match the selected filter.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {[
                    'Display Name', 'UPN', 'Status', 'MFA',
                    'License', 'Profile Country', 'Pwd Expires', 'Department',
                    'Last Sign-in', 'Created',
                  ].map(h => (
                    <th
                      key={h}
                      style={{
                        padding: '11px 14px',
                        textAlign: 'left',
                        fontWeight: 600,
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.07em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(u => (
                  <tr
                    key={u.azure_id}
                    style={{
                      borderBottom: '1px solid var(--border-dim)',
                      ...rowBorderStyle(u),
                    }}
                  >
                    {/* Display Name */}
                    <td style={{
                      padding: '11px 14px',
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                    }}>
                      {u.display_name ?? <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    </td>

                    {/* UPN */}
                    <td style={{
                      padding: '11px 14px',
                      color: 'var(--text-muted)',
                      fontSize: 12,
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {u.upn ?? '--'}
                    </td>

                    {/* Status */}
                    <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                      <StatusBadge enabled={u.is_deleted ? null : u.account_enabled} />
                    </td>

                    {/* MFA */}
                    <td style={{ padding: '11px 14px', textAlign: 'center' }}>
                      <MfaBadge registered={u.is_deleted ? null : u.mfa_registered} />
                    </td>

                    {/* License */}
                    <td style={{ padding: '11px 14px', maxWidth: 180 }}>
                      <LicenseCell names={u.license_names} />
                    </td>

                    {/* Country */}
                    <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                      <CountryCell country={u.profile_country} isForeign={u.is_foreign_signin} />
                    </td>

                    {/* Password Expires */}
                    <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
                      <PwdExpiresBadge iso={u.password_expires_at} />
                    </td>

                    {/* Department */}
                    <td style={{
                      padding: '11px 14px',
                      color: 'var(--text-muted)',
                      fontSize: 12,
                      maxWidth: 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {u.department ?? <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    </td>

                    {/* Last Sign-in */}
                    <td style={{
                      padding: '11px 14px',
                      color: 'var(--text-muted)',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                    }}>
                      {fmtDate(u.last_sign_in)}
                    </td>

                    {/* Created */}
                    <td style={{
                      padding: '11px 14px',
                      color: 'var(--text-dim)',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                    }}>
                      {fmtDate(u.created_at_azure)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Row count */}
      {!loading && !error && filtered.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)', textAlign: 'right' }}>
          {filtered.length} user{filtered.length !== 1 ? 's' : ''}
          {tab !== 'all' ? ` · ${users.length} total` : ''}
        </div>
      )}

    </div>
  )
}
