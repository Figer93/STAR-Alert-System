import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { getPatchStatus, type PatchStatusRow } from '../../lib/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Badge components ──────────────────────────────────────────────────────────

function CountBadge({
  count,
  type,
}: {
  count: number
  type: 'failed' | 'pending' | 'neutral'
}) {
  let bg = 'transparent'
  let border = 'var(--border)'
  let color = 'var(--text-muted)'

  if (type === 'failed' && count > 0) {
    bg     = 'rgba(239,68,68,0.15)'
    border = 'rgba(239,68,68,0.4)'
    color  = '#ef4444'
  } else if (type === 'pending' && count > 5) {
    bg     = 'rgba(234,179,8,0.15)'
    border = 'rgba(234,179,8,0.4)'
    color  = '#eab308'
  }

  return (
    <span style={{
      display:      'inline-block',
      minWidth:     32,
      textAlign:    'center',
      padding:      '2px 8px',
      borderRadius: 6,
      fontSize:     13,
      fontWeight:   600,
      background:   bg,
      border:       `1px solid ${border}`,
      color,
    }}>
      {count}
    </span>
  )
}

function RebootBadge({ required }: { required: boolean }) {
  if (required) {
    return (
      <span style={{
        display:      'inline-block',
        padding:      '2px 10px',
        borderRadius: 6,
        fontSize:     12,
        fontWeight:   600,
        background:   'rgba(239,68,68,0.15)',
        border:       '1px solid rgba(239,68,68,0.4)',
        color:        '#ef4444',
      }}>
        Reboot
      </span>
    )
  }
  return (
    <span style={{
      display:      'inline-block',
      padding:      '2px 10px',
      borderRadius: 6,
      fontSize:     12,
      fontWeight:   600,
      background:   'rgba(34,197,94,0.12)',
      border:       '1px solid rgba(34,197,94,0.3)',
      color:        '#22c55e',
    }}>
      ✓
    </span>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function PatchCompliance() {
  const [rows, setRows]       = useState<PatchStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    getPatchStatus()
      .then(data => {
        setRows(data)
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load patch compliance data')
        setLoading(false)
      })
  }, [])

  const totalFailed   = rows.reduce((s, r) => s + r.patches_failed, 0)
  const needsReboot   = rows.filter(r => r.reboot_required).length
  const totalPending  = rows.reduce((s, r) => s + r.patches_pending, 0)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <ShieldAlert size={22} color="var(--accent)" />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-head)', margin: 0 }}>
            Patch Compliance
          </h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          Windows Update status synced from NinjaRMM every 10 minutes.
        </p>
      </div>

      {/* Summary cards */}
      {!loading && !error && rows.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 16,
          marginBottom: 28,
        }}>
          {[
            { label: 'Devices',        value: rows.length,    color: 'var(--text-primary)' },
            { label: 'Failed patches', value: totalFailed,    color: totalFailed  > 0 ? '#ef4444' : 'var(--text-primary)' },
            { label: 'Pending patches', value: totalPending,  color: totalPending > 5 ? '#eab308' : 'var(--text-primary)' },
            { label: 'Need reboot',    value: needsReboot,    color: needsReboot  > 0 ? '#ef4444' : 'var(--text-primary)' },
          ].map(card => (
            <div key={card.label} className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                {card.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: card.color }}>
                {card.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            Loading patch data…
          </div>
        ) : error ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#ef4444', fontSize: 14 }}>
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            No patch data available yet — NinjaRMM sync may not have run.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Hostname', 'OS', 'Approved', 'Pending', 'Failed', 'Reboot Required', 'Last Scan'].map(h => (
                    <th
                      key={h}
                      style={{
                        padding:     '11px 16px',
                        textAlign:   'left',
                        fontWeight:  600,
                        fontSize:    11,
                        color:       'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.07em',
                        whiteSpace:  'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr
                    key={row.ninja_id}
                    style={{ borderBottom: '1px solid var(--border-dim)' }}
                  >
                    <td style={{ padding: '11px 16px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                      {row.hostname}
                    </td>
                    <td style={{ padding: '11px 16px', color: 'var(--text-muted)', fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.os_name ?? '--'}
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <CountBadge count={row.patches_approved} type="neutral" />
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <CountBadge count={row.patches_pending} type="pending" />
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <CountBadge count={row.patches_failed} type="failed" />
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <RebootBadge required={row.reboot_required} />
                    </td>
                    <td style={{ padding: '11px 16px', color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtDate(row.last_scan)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
