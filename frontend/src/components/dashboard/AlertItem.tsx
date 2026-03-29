import { useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCheck, Info, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Alert } from '../../types'
import { acknowledgeAlert } from '../../lib/api'

const SEV_LABEL: Record<string, string> = {
  critical: 'CRITICAL', warning: 'WARNING', info: 'INFO', ok: 'OK',
}

function relativeTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
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
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: isResolved ? 0.45 : 1, x: 0 }}
      exit={{ opacity: 0, x: 8, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onClick={() => onDetail(alert)}
      style={{
        display: 'flex',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      }}
      whileHover={{
        borderColor: 'var(--border-bright)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
      }}
    >
      {/* Severity glow bar */}
      <div
        className={`sev-bar-${alert.severity}`}
        style={{ width: 3, flexShrink: 0 }}
      />

      <div style={{ flex: 1, padding: '9px 13px', minWidth: 0 }}>
        {/* Row 1: source · title · badge */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <span style={{
              color: 'var(--text-dim)', fontSize: 10,
              textTransform: 'uppercase', letterSpacing: '0.07em',
              flexShrink: 0, fontWeight: 600,
            }}>
              {alert.source?.name ?? 'Unknown'}
            </span>
            <span style={{
              color: 'var(--text-head)', fontSize: 13, fontWeight: 500,
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
          marginBottom: 7,
        }}>
          {alert.message}
        </div>

        {/* Row 3: time · occurrence · actions */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
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

          <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
            {!isAcked && !isResolved && (
              <button
                className="btn"
                onClick={handleAck}
                disabled={acking}
                style={{ fontSize: 11, padding: '2px 9px', gap: 5 }}
              >
                <CheckCheck size={11} />
                {acking ? '…' : 'Ack'}
              </button>
            )}
            <button
              className="btn"
              onClick={e => { e.stopPropagation(); onDetail(alert) }}
              style={{ fontSize: 11, padding: '2px 9px', gap: 5 }}
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
