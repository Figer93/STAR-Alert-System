import type { Source } from '../../types'

function relativeTime(iso: string | null) {
  if (!iso) return 'never'
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function isStale(iso: string | null): boolean {
  if (!iso) return true
  return (Date.now() - new Date(iso).getTime()) > 5 * 60 * 1000
}

interface Props {
  sources: Source[]
}

const DOT_COLOUR: Record<string, string> = {
  online:  'var(--green)',
  offline: 'var(--red)',
  unknown: 'var(--text-dim)',
}

const PILL_BG: Record<string, string> = {
  online:  'rgba(34,197,94,0.10)',
  offline: 'rgba(239,68,68,0.10)',
  unknown: 'rgba(100,116,139,0.10)',
}

const PILL_BORDER: Record<string, string> = {
  online:  'rgba(34,197,94,0.20)',
  offline: 'rgba(239,68,68,0.20)',
  unknown: 'rgba(100,116,139,0.15)',
}

const PILL_TEXT: Record<string, string> = {
  online:  'var(--green)',
  offline: 'var(--red)',
  unknown: 'var(--text-dim)',
}

export default function SourceStatus({ sources }: Props) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '12px 14px',
    }}>
      <div style={{
        color: 'var(--text-dim)', fontSize: 10,
        textTransform: 'uppercase', letterSpacing: '0.10em',
        fontWeight: 500, marginBottom: 10,
      }}>
        Sources
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sources.map(s => {
          const st = s.status ?? 'unknown'
          const stale = st === 'online' && isStale(s.last_seen)
          return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8,
            }}>
              {/* Left: dot + name */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: DOT_COLOUR[st],
                  boxShadow: st === 'online' ? '0 0 5px var(--green)' : 'none',
                }} />
                <span style={{
                  color: 'var(--text-head)', fontSize: 12, fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.name}
                </span>
              </div>

              {/* Right: last seen + status pill */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{
                  fontSize: 10,
                  color: stale ? 'var(--red)' : 'var(--text-dim)',
                }}>
                  {relativeTime(s.last_seen)}
                </span>
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '1px 7px',
                  borderRadius: 20,
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                  textTransform: 'uppercase',
                  color: PILL_TEXT[st],
                  background: PILL_BG[st],
                  border: `1px solid ${PILL_BORDER[st]}`,
                }}>
                  {st}
                </span>
              </div>
            </div>
          )
        })}

        {sources.length === 0 && (
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>No sources configured</span>
        )}
      </div>
    </div>
  )
}
