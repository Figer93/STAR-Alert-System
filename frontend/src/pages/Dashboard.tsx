import { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, Info, Server, Activity } from 'lucide-react'
import type { Source } from '../types'
import { getSources } from '../lib/api'
import { useAlerts } from '../hooks/useAlerts'
import MetricCard from '../components/dashboard/MetricCard'
import AlertFeed from '../components/dashboard/AlertFeed'
import SourceStatus from '../components/dashboard/SourceStatus'
import ActivityChart from '../components/dashboard/ActivityChart'
import { MetricCardSkeleton } from '../components/Skeleton'

export default function Dashboard() {
  const { alerts, stats, loading, wsConnected, acknowledgeLocal } = useAlerts()
  const [sources, setSources] = useState<Source[]>([])

  useEffect(() => {
    getSources().then(setSources).catch(() => {})
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', minHeight: 0, overflow: 'hidden' }}>

      {/* Metric row */}
      <div className="metric-row" style={{ display: 'flex', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <MetricCardSkeleton key={i} />)
        ) : (
          <>
            <MetricCard label="Critical"       value={stats?.critical ?? 0}     colour="var(--red)"   glow="var(--glow-red)"   icon={AlertCircle} />
            <MetricCard label="Warning"        value={stats?.warning ?? 0}      colour="var(--amber)" glow="var(--glow-amber)" icon={AlertTriangle} />
            <MetricCard label="Info"           value={stats?.info ?? 0}         colour="var(--blue)"  glow="var(--glow-blue)"  icon={Info} />
            <MetricCard label="Sources Online" value={stats ? `${stats.sources_online}/${stats.sources_total}` : '—'} colour="var(--green)" glow="var(--glow-green)" icon={Server} />
            <MetricCard label="Active Alerts"  value={stats?.total_active ?? 0} icon={Activity} />
          </>
        )}
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>

        {/* Alert feed */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <AlertFeed
            alerts={alerts}
            sources={sources}
            onAcknowledge={acknowledgeLocal}
            loading={loading}
          />
        </div>

        {/* Right sidebar */}
        <div className="dashboard-sidebar" style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SourceStatus sources={sources} />
          <ActivityChart />

          {/* WS status */}
          <div className="card" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background:  wsConnected ? 'var(--green)' : 'var(--red)',
              boxShadow:   wsConnected ? '0 0 6px var(--green)' : '0 0 6px var(--red)',
            }} />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {wsConnected ? 'Live updates active' : 'Reconnecting…'}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .dashboard-sidebar { display: none; }
        }
        @media (max-width: 640px) {
          /* Stack metric cards 2-up on small screens */
          div[style*="flex: 1"][style*="minWidth: 0"] { min-width: calc(50% - 5px) !important; flex: unset !important; }
        }
      `}</style>
    </div>
  )
}
