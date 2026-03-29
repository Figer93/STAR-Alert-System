import type { Source } from '../../types'

function relativeTime(iso: string | null) {
  if (!iso) return 'never'
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

interface Props {
  sources: Source[]
}

const STATUS_COLOUR: Record<string, string> = {
  online: 'var(--green)',
  offline: 'var(--red)',
  unknown: 'var(--text-dim)',
}

export default function SourceStatus({ sources }: Props) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '10px 14px',
    }}>
      <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        Sources
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sources.map(s => (
          <div key={s.id} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: STATUS_COLOUR[s.status],
                  boxShadow: s.status === 'online' ? '0 0 4px var(--green)' : 'none',
                }}
              />
              <span style={{ color: 'var(--text-head)', fontSize: 12 }}>{s.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{relativeTime(s.last_seen)}</span>
              <span
                style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  color: STATUS_COLOUR[s.status],
                  textTransform: 'uppercase',
                }}
              >
                {s.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
