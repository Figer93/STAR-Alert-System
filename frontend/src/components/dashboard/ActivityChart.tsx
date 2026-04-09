import { useEffect, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { getTimeline } from '../../lib/api'
import type { TimelineBucket } from '../../types'

function formatHour(iso: string) {
  const d = new Date(iso)
  return d.getUTCHours().toString().padStart(2, '0') + ':00'
}

const TooltipContent = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-bright)',
      borderRadius: 6, padding: '6px 10px', fontSize: 11,
    }}>
      <div style={{ color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ color: 'var(--text-head)', fontWeight: 600 }}>{payload[0].value} alerts</div>
    </div>
  )
}

export default function ActivityChart() {
  const [data, setData] = useState<TimelineBucket[]>([])

  useEffect(() => {
    getTimeline(24).then(setData).catch(() => {})
    const t = setInterval(() => getTimeline(24).then(setData).catch(() => {}), 60_000)
    return () => clearInterval(t)
  }, [])

  const displayData = data.map(b => ({ ...b, label: formatHour(b.hour) }))
  const totalCount  = data.reduce((sum, b) => sum + b.count, 0)

  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{
          color: 'var(--text-dim)', fontSize: 10,
          textTransform: 'uppercase', letterSpacing: '0.10em', fontWeight: 500,
        }}>
          Activity — last 24h
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600,
          color: totalCount > 0 ? 'var(--text-head)' : 'var(--text-dim)',
        }}>
          {totalCount} total
        </span>
      </div>

      <ResponsiveContainer width="100%" height={96}>
        <AreaChart data={displayData} margin={{ top: 4, right: 0, bottom: 0, left: -30 }}>
          <defs>
            <linearGradient id="activityGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="var(--blue)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--blue)" stopOpacity={0}   />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--text-dim)', fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            interval={5}
          />
          <YAxis
            tick={{ fill: 'var(--text-dim)', fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip content={<TooltipContent />} cursor={{ stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="count"
            stroke="var(--blue)"
            strokeWidth={1.5}
            fill="url(#activityGrad)"
            dot={false}
            activeDot={{ r: 3, fill: 'var(--blue)', strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
