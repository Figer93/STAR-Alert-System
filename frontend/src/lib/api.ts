import axios, { type AxiosError } from 'axios'
import { toast } from 'sonner'
import type { Alert, AlertsResponse, Source, StatsSummary, TimelineBucket, Rule } from '../types'

const api = axios.create({ baseURL: '/api' })

// Response error interceptor — surfaces API errors as toasts
api.interceptors.response.use(
  res => res,
  (err: AxiosError) => {
    const status  = err.response?.status
    const detail  = (err.response?.data as { detail?: string })?.detail
    const message = detail ?? err.message ?? 'Request failed'

    if (status === 404) {
      // silently ignore 404s — likely stale data
    } else if (status && status >= 500) {
      toast.error(`Server error (${status}): ${message}`)
    } else if (!err.response) {
      toast.error('Backend unreachable — check server is running')
    } else {
      toast.warning(message)
    }

    return Promise.reject(err)
  }
)

// ── Alerts ────────────────────────────────────────────────────────────────────

export interface AlertFilters {
  severity?: string
  source?: string
  status?: string
  limit?: number
  offset?: number
}

export const getAlerts = (filters: AlertFilters = {}) =>
  api.get<AlertsResponse>('/alerts', { params: filters }).then(r => r.data)

export const getAlert = (id: number) =>
  api.get<Alert>(`/alerts/${id}`).then(r => r.data)

export const acknowledgeAlert = (id: number, acknowledged_by = 'dashboard') =>
  api.patch<Alert>(`/alerts/${id}/acknowledge`, { acknowledged_by }).then(r => r.data)

export const resolveAlert = (id: number) =>
  api.patch<Alert>(`/alerts/${id}/resolve`).then(r => r.data)

export const deleteAlert = (id: number) =>
  api.delete(`/alerts/${id}`)

// ── Sources ───────────────────────────────────────────────────────────────────

export const getSources = () =>
  api.get<Source[]>('/sources').then(r => r.data)

export const updateSource = (id: number, data: { enabled?: boolean; config?: Record<string, unknown> }) =>
  api.patch<Source>(`/sources/${id}`, data).then(r => r.data)

export const testSource = (id: number) =>
  api.get(`/sources/${id}/test`).then(r => r.data)

// ── Stats ─────────────────────────────────────────────────────────────────────

export const getStatsSummary = () =>
  api.get<StatsSummary>('/stats/summary').then(r => r.data)

export const getTimeline = (hours = 24) =>
  api.get<TimelineBucket[]>('/stats/timeline', { params: { hours } }).then(r => r.data)

// ── Rules ─────────────────────────────────────────────────────────────────────

export const getRules = () =>
  api.get<Rule[]>('/rules').then(r => r.data)

export const createRule = (data: Omit<Rule, 'id' | 'created_at'>) =>
  api.post<Rule>('/rules', data).then(r => r.data)

export const updateRule = (id: number, data: Partial<Rule>) =>
  api.patch<Rule>(`/rules/${id}`, data).then(r => r.data)

export const deleteRule = (id: number) =>
  api.delete(`/rules/${id}`)

// ── Notifications ─────────────────────────────────────────────────────────────

export const sendTestNotification = (channel: 'telegram' | 'email', severity = 'warning') =>
  api.post<{ success: boolean; error: string | null }>('/notifications/test', { channel, severity }).then(r => r.data)

// ── Maintenance ───────────────────────────────────────────────────────────────

export interface MaintenanceStatus {
  active: boolean
  until: string | null
  remaining_seconds: number
}

export const getMaintenanceStatus = () =>
  api.get<MaintenanceStatus>('/maintenance/status').then(r => r.data)

export const startMaintenance = (minutes: number) =>
  api.post<MaintenanceStatus>('/maintenance/start', { minutes }).then(r => r.data)

export const stopMaintenance = () =>
  api.post<MaintenanceStatus>('/maintenance/stop').then(r => r.data)

// ── CSV export ────────────────────────────────────────────────────────────────

export const exportAlertsCsv = () => {
  window.open('/api/alerts/export?format=csv', '_blank')
}
