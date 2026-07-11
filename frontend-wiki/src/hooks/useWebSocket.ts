import { useRef, useCallback, useEffect } from 'react'
import { getToken } from '../lib/auth'
import type { WSMessage } from '../lib/types'

export interface ChatContext {
  path: string | null
  selection: string
}

interface UseWebSocketReturn {
  send: (text: string, context?: ChatContext) => Promise<void>
}

export function useWebSocket(
  onText: (id: string, text: string) => void,
  onTool: (name: string, detail: string) => void,
  onError: (text: string) => void,
  onDone: (sid?: string) => void,
  onDisconnect: () => void,
): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)

  const connect = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const token = getToken()
      if (!token) { reject(new Error('No token')); return }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${proto}//${location.host}/chat/ws?token=${encodeURIComponent(token)}`)

      socket.onopen = () => {
        wsRef.current = socket
        resolve(socket)
      }

      socket.onmessage = (e) => {
        try {
          const msg: WSMessage = JSON.parse(e.data)
          if (msg.t === 'text') {
            onText(msg.id, msg.text)
          } else if (msg.t === 'tool') {
            const detail = msg.pattern || (msg.file ? msg.file.split('/').slice(-2).join('/') : '')
            onTool(msg.name, detail)
          } else if (msg.t === 'error') {
            onError(msg.text)
          } else if (msg.t === 'done') {
            onDone(msg.sid)
          }
        } catch { /* ignore parse errors */ }
      }

      socket.onclose = (e) => {
        wsRef.current = null
        if (e.code === 4001 || e.code === 4003) {
          onDisconnect()
        }
      }

      socket.onerror = () => {
        wsRef.current = null
        reject(new Error('WebSocket error'))
      }
    })
  }, [onText, onTool, onError, onDone, onDisconnect])

  const send = useCallback(async (text: string, context?: ChatContext) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      await connect()
    }
    wsRef.current!.send(JSON.stringify({ type: 'message', text, context }))
  }, [connect])

  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  return { send }
}
