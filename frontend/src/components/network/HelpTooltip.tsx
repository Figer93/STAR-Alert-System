import { useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'

// ── Metric definitions ─────────────────────────────────────────────────────────

interface MetricDef {
  label:       string
  what:        string
  normal:      string
  abnormal:    string
}

const METRICS: Record<string, MetricDef> = {
  rtt_ms: {
    label:    'Round-trip time (ms)',
    what:     'How long it takes a packet to travel to a destination and back. A direct measure of latency.',
    normal:   'Under 5ms to internal devices, under 50ms to internet destinations.',
    abnormal: 'Consistently high RTT indicates congestion, a routing issue, or a saturated link.',
  },
  packet_loss: {
    label:    'Packet loss (%)',
    what:     'Percentage of packets sent that never received a reply. Even small amounts degrade real-time traffic.',
    normal:   '0% — any sustained loss is abnormal.',
    abnormal: 'Above 1%: voice/video calls break up. Above 5%: serious reliability problem requiring investigation.',
  },
  rx_errors: {
    label:    'Receive errors',
    what:     'Frames the switch port received but had to discard due to CRC or alignment errors.',
    normal:   '0 — errors should not occur on a healthy link.',
    abnormal: 'Any non-zero value points to a bad cable, faulty NIC, duplex mismatch, or overloaded port.',
  },
  tx_bytes_rate: {
    label:    'Transmit rate',
    what:     'Volume of data being sent from this device per second, as measured at the switch port.',
    normal:   'Varies by device role. Servers transmit more; workstations are bursty.',
    abnormal: 'A sudden spike may indicate a backup job, data exfiltration, or a runaway process.',
  },
  health_score: {
    label:    'Health score (0–100)',
    what:     'Composite score calculated from WAN stability, switch port errors, and device uptime over the last hour.',
    normal:   '90–100 is healthy. 70–89 is degraded but functional.',
    abnormal: 'Below 70 indicates active issues. Below 50 means multiple problems are affecting the network.',
  },
}

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  metric:    keyof typeof METRICS | string
  placement?: 'top' | 'bottom'
}

export default function HelpTooltip({ metric, placement = 'top' }: Props) {
  const def = METRICS[metric] ?? null
  const [visible, setVisible] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  if (!def) return null

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={btnRef}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        aria-label={`Help: ${def.label}`}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'help',
          padding: '0 2px',
          color: 'var(--text-muted)',
          display: 'inline-flex',
          alignItems: 'center',
          lineHeight: 1,
        }}
      >
        <HelpCircle size={13} />
      </button>

      {visible && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 200,
            ...(placement === 'top'
              ? { bottom: 'calc(100% + 8px)' }
              : { top:    'calc(100% + 8px)' }),
            left: '50%',
            transform: 'translateX(-50%)',
            width: 280,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-bright)',
            borderRadius: 'var(--radius)',
            padding: '12px 14px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            pointerEvents: 'none',
          }}
        >
          {/* Arrow */}
          <div style={{
            position: 'absolute',
            ...(placement === 'top'
              ? { bottom: -5, borderTopColor: 'var(--border-bright)', borderTopWidth: 5, borderBottomWidth: 0 }
              : { top:    -5, borderBottomColor: 'var(--border-bright)', borderBottomWidth: 5, borderTopWidth: 0 }),
            left: '50%',
            transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderStyle: 'solid',
          }} />

          <p style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-head)', marginBottom: 8 }}>
            {def.label}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Row icon="📖" label="What it means" text={def.what} />
            <Row icon="✅" label="Normal range"  text={def.normal}   color="var(--green)" />
            <Row icon="⚠️" label="If abnormal"   text={def.abnormal} color="var(--amber)" />
          </div>
        </div>
      )}
    </span>
  )
}

function Row({ icon, label, text, color }: { icon: string; label: string; text: string; color?: string }) {
  return (
    <div>
      <span style={{ fontSize: 11, color: color ?? 'var(--text-muted)', fontWeight: 600 }}>
        {icon} {label}
      </span>
      <p style={{ fontSize: 11, color: 'var(--text)', margin: '2px 0 0', lineHeight: 1.45 }}>{text}</p>
    </div>
  )
}
