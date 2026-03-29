import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
          <Header wsConnected={wsConnected} />
          <main style={{ flex: 1, overflow: 'hidden' }}>
            <Suspense fallback={null}>
            <Routes>
              <Route path="/"        element={<Dashboard />} />
              <Route path="/history" element={<AlertHistory />} />
              <Route path="/sources" element={<Sources />} />
              <Route path="/settings" element={<Settings />} />
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
