import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { Toaster, toast } from 'sonner'
import { AnimatePresence } from 'framer-motion'
import { AppShell, RouteMotion } from './components/layout/AppShell'
import { CommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { notificationService } from './lib/notifications'
import type { WSMessage } from './types'

const Dashboard        = lazy(() => import('./pages/Dashboard'))
const AlertHistory     = lazy(() => import('./pages/AlertHistory'))
const Sources          = lazy(() => import('./pages/Sources'))
const Settings         = lazy(() => import('./pages/Settings'))

const NetworkOverview    = lazy(() => import('./pages/network/Overview'))
const NetworkPorts       = lazy(() => import('./pages/network/Ports'))
const NetworkLatency     = lazy(() => import('./pages/network/Latency'))
const NetworkTraffic     = lazy(() => import('./pages/network/Traffic'))
const NetworkInvestigate = lazy(() => import('./pages/network/Investigate'))
const NetworkDevices     = lazy(() => import('./pages/network/Devices'))
const NetworkSettings    = lazy(() => import('./pages/network/NetworkSettings'))
const NetworkIncidents   = lazy(() => import('./pages/network/Incidents'))
const SystemHealth       = lazy(() => import('./pages/system/SystemHealth'))

// ── Keyboard shortcuts (G+key navigation) ────────────────────────────────────
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

// ── Animated Routes ───────────────────────────────────────────────────────────
function AnimatedRoutes() {
  const location = useLocation()

  return (
    <AnimatePresence mode="wait" initial={false}>
      <Routes location={location} key={location.pathname}>
        <Route path="/"        element={<RouteMotion><Dashboard /></RouteMotion>} />
        <Route path="/history" element={<RouteMotion><AlertHistory /></RouteMotion>} />
        <Route path="/sources" element={<RouteMotion><Sources /></RouteMotion>} />
        <Route path="/settings" element={<RouteMotion><Settings /></RouteMotion>} />
        <Route path="/network"             element={<RouteMotion><NetworkOverview /></RouteMotion>} />
        <Route path="/network/ports"       element={<RouteMotion><NetworkPorts /></RouteMotion>} />
        <Route path="/network/latency"     element={<RouteMotion><NetworkLatency /></RouteMotion>} />
        <Route path="/network/traffic"     element={<RouteMotion><NetworkTraffic /></RouteMotion>} />
        <Route path="/network/investigate" element={<RouteMotion><NetworkInvestigate /></RouteMotion>} />
        <Route path="/network/devices"     element={<RouteMotion><NetworkDevices /></RouteMotion>} />
        <Route path="/network/incidents"   element={<RouteMotion><NetworkIncidents /></RouteMotion>} />
        <Route path="/network/settings"    element={<RouteMotion><NetworkSettings /></RouteMotion>} />
        <Route path="/system/health"       element={<RouteMotion><SystemHealth /></RouteMotion>} />
      </Routes>
    </AnimatePresence>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [wsConnected, setWsConnected]   = useState(false)
  const [cmdOpen, setCmdOpen]           = useState(false)
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
        if (msg.event === 'ping') {
          socket.send('pong')
        } else if (msg.event === 'alert.new') {
          const a = msg.payload as { severity?: string; title?: string; source?: { name?: string } }
          const sev = a.severity ?? 'info'
          const title = a.title ?? 'New alert'
          const src = a.source?.name ? ` · ${a.source.name}` : ''
          if (sev === 'critical') {
            toast.error(`${title}${src}`, { duration: 6000 })
          } else if (sev === 'warning') {
            toast.warning(`${title}${src}`, { duration: 4000 })
          } else {
            toast.message(`${title}${src}`, { duration: 3000 })
          }
        }
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
    notificationService.requestBrowserPermission()
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <KeyboardShortcuts />
        <AppShell
          wsConnected={wsConnected}
          onSearchOpen={() => setCmdOpen(true)}
        >
          <Suspense fallback={null}>
            <AnimatedRoutes />
          </Suspense>
        </AppShell>
        <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
        <Toaster
          position="bottom-right"
          theme="dark"
          toastOptions={{
            style: {
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-bright)',
              color: 'var(--text-head)',
              fontSize: '13px',
              borderRadius: '5px',
            },
          }}
        />
      </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
