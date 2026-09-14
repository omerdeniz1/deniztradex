import { useEffect, useRef, useState, useCallback } from 'react'
import { getWsUrl, WS_HOSTS } from '@/services/binance'
import type { Ticker } from '@/types'

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

const RECONNECT_DELAY = 2000
const MAX_RECONNECT = 10

interface TickerMessage {
  e: '24hrTicker'
  s: string
  c: string
  p: string
  P: string
  v: string
}

export function useBinanceTicker(symbol: string) {
  const [ticker, setTicker] = useState<Ticker | null>(null)
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectCount = useRef(0)
  const mountedRef = useRef(true)

  const cleanup = useCallback(() => {
    mountedRef.current = false
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.onmessage = null
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    setTicker(null)
    setStatus('disconnected')
    let timeout: ReturnType<typeof setTimeout> | undefined

    function connect() {
      if (!mountedRef.current) return

      setStatus(reconnectCount.current > 0 ? 'reconnecting' : 'connecting')
      const url = getWsUrl(symbol, 'ticker', reconnectCount.current % WS_HOSTS.length)
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mountedRef.current) return
        setStatus('connected')
        reconnectCount.current = 0
      }

      ws.onmessage = (event) => {
        if (!mountedRef.current) return
        try {
          const msg = JSON.parse(event.data) as TickerMessage
          if (msg.e !== '24hrTicker') return
          setTicker({
            symbol: msg.s,
            price: parseFloat(msg.c),
            change24h: parseFloat(msg.p),
            changePercent24h: parseFloat(msg.P),
            volume24h: parseFloat(msg.v),
          })
        } catch {
          // malformed message — ignore
        }
      }

      ws.onerror = () => {
        // onclose will fire after onerror
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        setStatus('disconnected')
        if (reconnectCount.current < MAX_RECONNECT) {
          reconnectCount.current += 1
          timeout = setTimeout(connect, RECONNECT_DELAY)
        }
      }
    }

    reconnectCount.current = 0
    connect()

    return () => {
      clearTimeout(timeout)
      cleanup()
      reconnectCount.current = 0
      setStatus('disconnected')
    }
  }, [symbol, cleanup])

  return { ticker, status }
}