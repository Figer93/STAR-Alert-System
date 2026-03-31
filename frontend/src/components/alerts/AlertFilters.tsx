import type { Source } from '../../types'

export interface Filters {
  severity: string
  source: string
  status: string
}

interface Props {
  filters: Filters
  sources: Source[]
  onChange: (f: Filters) => void
}

const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 6,
  color: 'var(--text-muted)',
  fontSize: 12,
  fontWeight: 500,
  padding: '4px 8px',
  cursor: 'pointer',
  outline: 'none',
  transition: 'border-color 0.15s, background 0.15s',
}

export default function AlertFilters({ filters, sources, onChange }: Props) {
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    onChange({ ...filters, [k]: e.target.value })

  const hasActive = !!(filters.severity || filters.source || filters.status)

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select style={selectStyle} value={filters.severity} onChange={set('severity')}>
        <option value="">All severities</option>
        <option value="critical">Critical</option>
        <option value="warning">Warning</option>
        <option value="info">Info</option>
        <option value="ok">OK</option>
      </select>

      <select style={selectStyle} value={filters.source} onChange={set('source')}>
        <option value="">All sources</option>
        {sources.map(s => (
          <option key={s.id} value={s.slug}>{s.name}</option>
        ))}
      </select>

      <select style={selectStyle} value={filters.status} onChange={set('status')}>
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="acknowledged">Acknowledged</option>
        <option value="resolved">Resolved</option>
      </select>

      {hasActive && (
        <button
          onClick={() => onChange({ severity: '', source: '', status: '' })}
          style={{
            ...selectStyle,
            color: 'var(--text-dim)',
            padding: '4px 10px',
          }}
        >
          Clear
        </button>
      )}
    </div>
  )
}
