import { useState, useMemo, useEffect, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { BellOff, Zap } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Alert, Source } from '../../types'
import AlertItem from './AlertItem'
import AlertFilters, { type Filters } from '../alerts/AlertFilters'
import AlertDetail from '../alerts/AlertDetail'
import { AlertFeedSkeleton } from '../Skeleton'

interface Props {
  alerts:        Alert[]
  sources:       Source[]
  onAcknowledge: (id: number, by: string) => void
  loading?:      boolean
}

export default function AlertFeed({ alerts, sources, onAcknowledge, loading }: Props) {
  const [filters, setFilters] = useState<Filters>({ severity: '', source: '', status: '' })
  const [detail, setDetail]   = useState<Alert | null>(null)
  const parentRef             = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    return alerts.filter(a => {
      if (filters.severity && a.severity !== filters.severity) return false
      if (filters.source   && a.source?.slug !== filters.source) return false
      if (filters.status   && a.status !== filters.status) return false
      return true
    })
  }, [alerts, filters])

  // Virtualise when list > 50 rows to keep DOM lean
  const virtualizer = useVirtualizer({
    count:         filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize:  () => 80,
    overscan:      8,
  })

  // Keyboard shortcut: Esc closes detail panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetail(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (loading) return <AlertFeedSkeleton />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: 1, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={13} color="var(--accent)" />
          <span style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Live Feed
          </span>
          <span style={{
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-bright)',
            borderRadius: 10, padding: '1px 7px',
            fontSize: 11, fontWeight: 600, color: 'var(--text-head)',
          }}>
            {filtered.length}
          </span>
        </div>
        <AlertFilters filters={filters} sources={sources} onChange={setFilters} />
      </div>

      {/* Feed — parentRef must always be mounted so virtualizer has a scroll container */}
      <div ref={parentRef} style={{ overflow: 'auto', flex: 1 }}>
        {filtered.length === 0 ? (
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '32px 24px', textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <BellOff size={28} color="var(--text-dim)" />
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              No alerts match the current filters
            </span>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            <AnimatePresence initial={false}>
              {virtualizer.getVirtualItems().map(vItem => {
                const a = filtered[vItem.index]
                return (
                  <div
                    key={a.id}
                    style={{
                      position: 'absolute', top: 0, left: 0, right: 0,
                      transform: `translateY(${vItem.start}px)`,
                      paddingBottom: 6,
                    }}
                  >
                    <AlertItem
                      alert={a}
                      onAcknowledge={onAcknowledge}
                      onDetail={setDetail}
                    />
                  </div>
                )
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      <AlertDetail alert={detail} onClose={() => setDetail(null)} />
    </div>
  )
}
