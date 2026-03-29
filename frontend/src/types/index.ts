export type Severity = 'critical' | 'warning' | 'info' | 'ok'
export type AlertStatus = 'active' | 'acknowledged' | 'resolved'
export type SourceStatus = 'online' | 'offline' | 'unknown'
export type SourceType = 'webhook' | 'syslog' | 'poll' | 'push'

export interface Source {
  id: number
  name: string
  slug: string
  adapter: string
  type: SourceType
  enabled: boolean
  config: Record<string, unknown>
  last_seen: string | null
  status: SourceStatus
  created_at: string
}

export interface Alert {
  id: number
  source_id: number | null
  source: Source | null
  severity: Severity
  title: string
  message: string
  raw_payload: Record<string, unknown>
  fingerprint: string
  status: AlertStatus
  first_seen: string
  last_seen: string
  occurrence_count: number
  notified_telegram: boolean
  notified_email: boolean
  acknowledged_by: string | null
  acknowledged_at: string | null
  resolved_at: string | null
}

export interface AlertsResponse {
  total: number
  alerts: Alert[]
}

export interface StatsSummary {
  critical: number
  warning: number
  info: number
  ok: number
  total_active: number
  sources_online: number
  sources_total: number
}

export interface TimelineBucket {
  hour: string
  count: number
}

export interface Rule {
  id: number
  name: string
  source_slug: string | null
  condition: Record<string, unknown>
  severity_override: Severity | null
  action: string
  notify_telegram: boolean
  notify_email: boolean
  cooldown_minutes: number
  enabled: boolean
  created_at: string
}

export interface WSMessage {
  event: string
  timestamp: string
  payload: Record<string, unknown>
}
