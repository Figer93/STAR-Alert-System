import { useState, useEffect, useCallback, useRef } from 'react'
import { getAlerts, getStatsSummary } from '../lib/api'
import { notificationService } from '../lib/notifications'
import type { Alert, StatsSummary, WSMessage } from '../types'

export function useAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = useRef(1000)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [alertsRes, statsRes] = await Promise.all([
        getAlerts({ limit: 100 }),
        getStatsSummary(),
      ])
      setAlerts(alertsRes.alerts)
      setTotal(alertsRes.total)
      setStats(statsRes)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleWsMessage = useCallback((msg: WSMessage) => {
    if (msg.event === 'alert.new') {
      const newAlert = msg.payload as unknown as Alert
      setAlerts(prev => [newAlert, ...prev])
      setTotal(prev => prev + 1)
      setStats(prev => {
        if (!prev) return prev
        const sev = newAlert.severity as keyof StatsSummary
        return { ...prev, [sev]: (prev[sev] as number) + 1, total_active: prev.total_active + 1 }
      })
      // Fire sound + browser notification
      notificationService.notify({
        severity:    newAlert.severity as 'critical' | 'warning' | 'info' | 'ok',
        title:       newAlert.title,
        source:      newAlert.source?.name,
        fingerprint: String(newAlert.id),
      })
    } else if (msg.event === 'alert.updated') {
      const { id, status, acknowledged_by } = msg.payload as { id: number; status: string; acknowledged_by?: string }
      setAlerts(prev =>
        prev.map(a =>
          a.id === id ? { ...a, status: status as Alert['status'], acknowledged_by: acknowledged_by ?? a.acknowledged_by } : a
        )
      )
      // Refresh stats on status change
      getStatsSummary().then(setStats).catch(() => {})
    } else if (msg.event === 'stats.update') {
      setStats(msg.payload as unknown as StatsSummary)
    }
  }, [])

  const connect = useCallback(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${wsProtocol}://${window.location.host}/ws`
    const socket = new WebSocket(wsUrl)
    wsRef.current = socket

    socket.onopen = () => {
      setWsConnected(true)
      retryDelay.current = 1000
      // Re-sync on reconnect to pick up any alerts missed during the disconnect window
      fetchAll()
    }

    socket.onmessage = (e) => {
      try {
        const msg: WSMessage = JSON.parse(e.data)
        if (msg.event === 'ping') { socket.send('pong'); return }
        handleWsMessage(msg)
      } catch { /* ignore */ }
    }

    socket.onclose = () => {
      setWsConnected(false)
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, 30000)
        connect()
      }, retryDelay.current)
    }

    socket.onerror = () => socket.close()
  }, [handleWsMessage])

  useEffect(() => {
    fetchAll()
    connect()
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      wsRef.current?.close()
    }
  }, [fetchAll, connect])

  const acknowledgeLocal = useCallback((id: number, by: string) => {
    setAlerts(prev =>
      prev.map(a => a.id === id ? { ...a, status: 'acknowledged', acknowledged_by: by } : a)
    )
    setStats(prev => prev ? { ...prev, total_active: Math.max(0, prev.total_active - 1) } : prev)
  }, [])

  const resolveLocal = useCallback((id: number) => {
    setAlerts(prev =>
      prev.map(a => a.id === id ? { ...a, status: 'resolved' } : a)
    )
    setStats(prev => prev ? { ...prev, total_active: Math.max(0, prev.total_active - 1) } : prev)
  }, [])

  return { alerts, total, stats, loading, wsConnected, fetchAll, acknowledgeLocal, resolveLocal }
}
