import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { Toaster, toast } from 'sonner'
import Header from './components/layout/Header'
import { ErrorBoundary } from './components/ErrorBoundary'
import { notificationService } from './lib/notifications'
import type { WSMessage } from './types'

const Dashboard    = lazy(() => import('./pages/Dashboard'))
const AlertHistory = lazy(() => import('./pages/AlertHistory'))
const Sources      = lazy(() => import('./pages/Sources'))
const Settings     = lazy(() => import('./pages/Settings'))

const NetworkOverview    = lazy(() => import('./pages/network/Overview'))
const NetworkPorts       = lazy(() => import('./pages/network/Ports'))
const NetworkLatency     = lazy(() => import('./pages/network/Latency'))
const NetworkTraffic     = lazy(() => import('./pages/network/Traffic'))
const NetworkInvestigate = lazy(() => import('./pages/network/Investigate'))
const NetworkDevices     = lazy(() => import('./pages/network/Devices'))
const NetworkSettings    = lazy(() => import('./pages/network/NetworkSettings'))
const NetworkIncidents   = lazy(() => import('./pages/network/Incidents'))

// ── Keyboard shortcuts (must be inside BrowserRouter for useNavigate) ─────────
// G then O/P/L/T/I/D/N/S → navigate to Network sub-pages
function KeyboardShortcuts() {
  const navigate = useNavigate()
  const pending  = useRef('')
  const timer    = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const ROUTES: Record<string, string> = {
      go: '/network',
      gp: '/network/ports',
      gl: '/network/latency',
      gt: '/network/traffic',
      gi: '/network/investigate',
      gd: '/network/devices',
      gn: '/network/incidents',
      gs: '/network/settings',
    }

    function handle(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (el.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key.length !== 1) return

      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => { pending.current = '' }, 1200)

      pending.current += key
      const dest = ROUTES[pending.current]
      if (dest) {
        navigate(dest)
        pending.current = ''
        if (timer.current) clearTimeout(timer.current)
      } else if (pending.current.length > 2) {
        pending.current = key
      }
    }

    window.addEventListener('keydown', handle)
    return () => {
      window.removeEventListener('keydown', handle)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [navigate])

  return null
}

function App() {
  const [wsConnected, setWsConnected] = useState(false)
  const wsRef       = useRef<WebSocket | null>(null)
  const retryTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay  = useRef(1000)
  const wasConnected = useRef(false)

  const connect = useCallback(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${wsProtocol}://${window.location.host}/ws`
    const socket = new WebSocket(wsUrl)
    wsRef.current = socket

    socket.onopen = () => {
      setWsConnected(true)
      retryDelay.current = 1000
      if (wasConnected.current) {
        toast.success('Reconnected to live feed')
      }
      wasConnected.current = true
    }

    socket.onmessage = (e) => {
      try {
        const msg: WSMessage = JSON.parse(e.data)
        if (msg.event === 'ping') socket.send('pong')
      } catch { /* ignore */ }
    }

    socket.onclose = () => {
      setWsConnected(false)
      if (wasConnected.current) {
        toast.error('Live feed disconnected — reconnecting…', { id: 'ws-disconnect' })
      }
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, 30000)
        connect()
      }, retryDelay.current)
    }

    socket.onerror = () => socket.close()
  }, [])

  useEffect(() => {
    connect()
    // Request browser notification permission on first load
    notificationService.requestBrowserPermission()
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
          <KeyboardShortcuts />
          <Header wsConnected={wsConnected} />
          <main style={{ flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={null}>
            <Routes>
              <Route path="/"        element={<Dashboard />} />
              <Route path="/history" element={<AlertHistory />} />
              <Route path="/sources" element={<Sources />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/network"             element={<NetworkOverview />} />
              <Route path="/network/ports"       element={<NetworkPorts />} />
              <Route path="/network/latency"     element={<NetworkLatency />} />
              <Route path="/network/traffic"     element={<NetworkTraffic />} />
              <Route path="/network/investigate" element={<NetworkInvestigate />} />
              <Route path="/network/devices"    element={<NetworkDevices />} />
              <Route path="/network/incidents"  element={<NetworkIncidents />} />
              <Route path="/network/settings"   element={<NetworkSettings />} />
            </Routes>
          </Suspense>
          </main>
        </div>
        <Toaster
          position="bottom-right"
          theme="dark"
          toastOptions={{
            style: {
              background: 'var(--bg-elevated)',
              border:     '1px solid var(--border-bright)',
              color:      'var(--text-head)',
              fontSize:   '13px',
            },
          }}
        />
      </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
