import { useEffect, useRef, useCallback } from 'react'
import type { WSMessage } from '../types'

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss' : 'ws'
const WS_URL = `${WS_PROTOCOL}://${window.location.host}/ws`

interface Options {
  onMessage: (msg: WSMessage) => void
}

export function useWebSocket({ onMessage }: Options) {
  const ws = useRef<WebSocket | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = useRef(1000)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    const socket = new WebSocket(WS_URL)
    ws.current = socket

    socket.onopen = () => {
      retryDelay.current = 1000
    }

    socket.onmessage = (e) => {
      try {
        const msg: WSMessage = JSON.parse(e.data)
        if (msg.event === 'ping') {
          socket.send('pong')
          return
        }
        onMessageRef.current(msg)
      } catch {
        // ignore malformed messages
      }
    }

    socket.onclose = () => {
      retryTimer.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, 30000)
        connect()
      }, retryDelay.current)
    }

    socket.onerror = () => {
      socket.close()
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      ws.current?.close()
    }
  }, [connect])

  return {
    isConnected: ws.current?.readyState === WebSocket.OPEN,
  }
}
