import { useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCheck, Info, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Alert } from '../../types'
import { acknowledgeAlert } from '../../lib/api'

const SEV_LABEL: Record<string, string> = {
  critical: 'CRITICAL', warning: 'WARNING', info: 'INFO', ok: 'OK',
}

const SEV_PILL_BG: Record<string, string> = {
  critical: 'rgba(239,68,68,0.12)',
  warning:  'rgba(245,158,11,0.12)',
  info:     'rgba(59,130,246,0.12)',
  ok:       'rgba(34,197,94,0.12)',
}

function relativeTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function fullUTC(iso: string) {
  return new Date(iso).toUTCString()
}

interface Props {
  alert:          Alert
  onAcknowledge:  (id: number, by: string) => void
  onDetail:       (alert: Alert) => void
}

export default function AlertItem({ alert, onAcknowledge, onDetail }: Props) {
  const [acking, setAcking] = useState(false)
  const isResolved = alert.status === 'resolved'
  const isAcked    = alert.status === 'acknowledged'
  const isMuted    = isResolved || isAcked

  const handleAck = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setAcking(true)
    try {
      await acknowledgeAlert(alert.id)
      onAcknowledge(alert.id, 'dashboard')
      toast.success('Alert acknowledged')
    } catch {
      toast.error('Failed to acknowledge')
    } finally {
      setAcking(false)
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -14, scale: 0.98 }}
      animate={{ opacity: isMuted ? 0.45 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 8, height: 0, marginBottom: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      onClick={() => onDetail(alert)}
      style={{
        display: 'flex',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
      whileHover={{
        background: 'rgba(255,255,255,0.05)',
        borderColor: 'var(--border-bright)',
      }}
    >
      {/* Severity glow bar */}
      <div
        className={`sev-bar-${alert.severity}`}
        style={{ width: alert.severity === 'critical' ? 4 : 3, flexShrink: 0 }}
      />

      <div style={{ flex: 1, padding: '11px 14px', minWidth: 0 }}>
        {/* Row 1: source pill · title · badge */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}>
            {/* Source pill */}
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '1px 7px',
              borderRadius: 20,
              fontSize: 10, fontWeight: 600, letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: `var(--${alert.severity === 'ok' ? 'green' : alert.severity === 'warning' ? 'amber' : alert.severity === 'critical' ? 'red' : 'blue'})`,
              background: SEV_PILL_BG[alert.severity] ?? 'rgba(255,255,255,0.06)',
              flexShrink: 0,
            }}>
              {alert.source?.name ?? 'Unknown'}
            </span>
            <span style={{
              color: 'var(--text-head)', fontSize: 14, fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {alert.title}
            </span>
          </div>

          <span
            className={`sev-${alert.severity}`}
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', flexShrink: 0 }}
          >
            {isAcked ? 'ACKED' : isResolved ? 'RESOLVED' : SEV_LABEL[alert.severity]}
          </span>
        </div>

        {/* Row 2: message */}
        <div style={{
          color: 'var(--text-muted)', fontSize: 12,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 8,
        }}>
          {alert.message}
        </div>

        {/* Row 3: time · occurrence · actions */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{ color: 'var(--text-dim)', fontSize: 11 }}
              title={fullUTC(alert.last_seen)}
            >
              {relativeTime(alert.last_seen)}
            </span>
            {alert.occurrence_count > 1 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                color: 'var(--amber)', fontSize: 11, fontWeight: 600,
              }}>
                <RefreshCw size={10} />
                ×{alert.occurrence_count}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
            {!isAcked && !isResolved && (
              <button
                onClick={handleAck}
                disabled={acking}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 11, padding: '2px 9px',
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.10)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-muted)',
                  cursor: acking ? 'wait' : 'pointer',
                  transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'
                  ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-head)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                  ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'
                }}
              >
                <CheckCheck size={11} />
                {acking ? '…' : 'Ack'}
              </button>
            )}
            <button
              onClick={e => { e.stopPropagation(); onDetail(alert) }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, padding: '2px 9px',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                transition: 'background 0.15s, border-color 0.15s, color 0.15s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-head)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'
              }}
            >
              <Info size={11} />
              Details
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
