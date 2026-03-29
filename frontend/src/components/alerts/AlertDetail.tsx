import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Copy, Check, AlertTriangle, Info, AlertCircle, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'
import type { Alert } from '../../types'

const SEV_ICONS = {
  critical: AlertCircle,
  warning:  AlertTriangle,
  info:     Info,
  ok:       CheckCircle,
}

function relativeTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(iso).toLocaleString()
}

interface Props {
  alert:   Alert | null
  onClose: () => void
}

export default function AlertDetail({ alert, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  const copyPayload = () => {
    if (!alert) return
    navigator.clipboard.writeText(JSON.stringify(alert.raw_payload, null, 2))
      .then(() => {
        setCopied(true)
        toast.success('Payload copied to clipboard')
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => toast.error('Copy failed'))
  }

  const SevIcon = alert ? (SEV_ICONS[alert.severity] ?? Info) : Info

  return (
    <AnimatePresence>
      {alert && (
        <motion.div
          key="detail-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}
          onClick={onClose}
        >
          {/* Backdrop */}
          <div className="overlay" style={{ zIndex: 50 }} />

          {/* Panel */}
          <motion.div
            key="detail-panel"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            onClick={e => e.stopPropagation()}
            className="alert-detail-panel"
            style={{
              position: 'relative', zIndex: 51,
              width: 440, maxWidth: '100vw', height: '100vh',
              background: 'var(--bg-surface)',
              borderLeft: '1px solid var(--border)',
              overflowY: 'auto',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 20px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
              position: 'sticky', top: 0, background: 'var(--bg-surface)', zIndex: 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SevIcon size={16} className={`sev-${alert.severity}`} />
                <span className={`sev-${alert.severity}`} style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {alert.severity}
                </span>
                <span style={{
                  background: 'var(--bg-raised)', border: '1px solid var(--border-bright)',
                  borderRadius: 3, padding: '1px 7px',
                  fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  {alert.status}
                </span>
              </div>
              <button className="btn btn-ghost" onClick={onClose} style={{ padding: 4 }} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 20, flex: 1 }}>
              {/* Title + message */}
              <div>
                <div style={{ color: 'var(--text-head)', fontSize: 15, fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>
                  {alert.title}
                </div>
                <div style={{ color: 'var(--text)', fontSize: 13, lineHeight: 1.6 }}>
                  {alert.message}
                </div>
              </div>

              {/* Metadata grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
                {([
                  ['Source',      alert.source?.name ?? '—'],
                  ['Status',      alert.status],
                  ['First seen',  relativeTime(alert.first_seen)],
                  ['Last seen',   relativeTime(alert.last_seen)],
                  ['Occurrences', String(alert.occurrence_count)],
                  ['Telegram',    alert.notified_telegram ? '✓ Sent' : '— Not sent'],
                  ['Email',       alert.notified_email    ? '✓ Sent' : '— Not sent'],
                  alert.acknowledged_by ? ['Acked by', alert.acknowledged_by] : null,
                ] as ([string, string] | null)[]).filter((x): x is [string, string] => x !== null).map(([k, v]) => (
                  <div key={k}>
                    <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
                      {k}
                    </div>
                    <div style={{ color: 'var(--text-head)', fontSize: 12 }}>{v}</div>
                  </div>
                ))}
              </div>

              {/* Divider */}
              <div style={{ borderTop: '1px solid var(--border)' }} />

              {/* Raw payload */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Raw Payload
                  </span>
                  <button className="btn btn-ghost" onClick={copyPayload} style={{ fontSize: 11, padding: '2px 8px', gap: 5 }}>
                    {copied ? <Check size={11} color="var(--green)" /> : <Copy size={11} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre
                  className="mono"
                  style={{
                    background: 'var(--bg-raised)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)', padding: '12px',
                    fontSize: 11, lineHeight: 1.6,
                    color: 'var(--text)', overflowX: 'auto',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    maxHeight: 360, overflowY: 'auto',
                  }}
                >
                  {JSON.stringify(alert.raw_payload, null, 2)}
                </pre>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
