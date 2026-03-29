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
  background: 'var(--bg-raised)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text)',
  fontSize: 12,
  padding: '3px 8px',
  cursor: 'pointer',
  outline: 'none',
}

export default function AlertFilters({ filters, sources, onChange }: Props) {
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    onChange({ ...filters, [k]: e.target.value })

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>Filter:</span>

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

      {(filters.severity || filters.source || filters.status) && (
        <button
          onClick={() => onChange({ severity: '', source: '', status: '' })}
          style={{ ...selectStyle, color: 'var(--text-dim)' }}
        >
          Clear
        </button>
      )}
    </div>
  )
}
