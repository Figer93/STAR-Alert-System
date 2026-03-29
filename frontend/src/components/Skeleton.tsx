interface SkeletonProps {
  width?:  string | number
  height?: string | number
  style?:  React.CSSProperties
}

export function Skeleton({ width = '100%', height = 16, style }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: 'var(--radius-sm)', ...style }}
    />
  )
}

export function MetricCardSkeleton() {
  return (
    <div className="card" style={{ padding: '10px 14px', flex: 1, minWidth: 0 }}>
      <Skeleton width={60} height={10} style={{ marginBottom: 8 }} />
      <Skeleton width={48} height={28} style={{ marginBottom: 6 }} />
      <Skeleton width={80} height={10} />
    </div>
  )
}

export function AlertItemSkeleton() {
  return (
    <div className="card" style={{ display: 'flex', overflow: 'hidden' }}>
      <div className="skeleton" style={{ width: 3, flexShrink: 0, height: 64 }} />
      <div style={{ flex: 1, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Skeleton width={80} height={10} />
          <Skeleton width={60} height={10} />
        </div>
        <Skeleton width="70%" height={13} />
        <Skeleton width="50%" height={11} />
      </div>
    </div>
  )
}

export function AlertFeedSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <AlertItemSkeleton key={i} />
      ))}
    </div>
  )
}
