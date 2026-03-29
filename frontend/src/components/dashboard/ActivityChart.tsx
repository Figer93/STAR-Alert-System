import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
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
      background: 'var(--bg-raised)', border: '1px solid var(--border)',
      borderRadius: 4, padding: '6px 10px', fontSize: 11,
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

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '10px 14px',
    }}>
      <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
        Activity — last 24h
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={displayData} barSize={6} margin={{ top: 0, right: 0, bottom: 0, left: -30 }}>
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
          <Tooltip content={<TooltipContent />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Bar dataKey="count" radius={[2, 2, 0, 0]}>
            {displayData.map((entry, i) => (
              <Cell key={i} fill={entry.count > 0 ? 'var(--blue)' : 'var(--border)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
