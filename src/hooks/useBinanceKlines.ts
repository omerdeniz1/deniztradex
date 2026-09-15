import { useEffect, useRef, useState, useCallback } from 'react'
import { fetchKlines, getWsUrl, WS_HOSTS } from '@/services/binance'
import { markDelisted } from '@/lib/delisted'
import type { Interval, Kline, TradingMode } from '@/types'

interface KlineMessage {
  e: 'kline'
  k: {
    o: string
    h: string
    l: string
    c: string
    v: string
    x: boolean
    t: number
    T: number
  }
}

export function useBinanceKlines(
  mode: TradingMode,
  symbol: string,
  interval: Interval,
) {
  const [klines, setKlines] = useState<Kline[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
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

  // Fetch historical klines
  useEffect(() => {
    mountedRef.current = true
    setIsLoading(true)
    setError(null)

    fetchKlines(mode, symbol, interval)
      .then((data) => {
        if (mountedRef.current) setKlines(data)
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          markDelisted(symbol)
          setError(err instanceof Error ? err.message : 'Failed to load klines')
        }
      })
      .finally(() => {
        if (mountedRef.current) setIsLoading(false)
      })

    return () => {
      cleanup()
    }
  }, [mode, symbol, interval, cleanup])

  // Stream live kline updates (with host rotation on failure).
  useEffect(() => {
    mountedRef.current = true
    let hostIndex = 0
    let timeout: ReturnType<typeof setTimeout> | undefined

    function connect() {
      const url = getWsUrl(symbol, 'kline', hostIndex % WS_HOSTS.length, interval)
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onmessage = (event) => {
        if (!mountedRef.current) return
        try {
          const msg = JSON.parse(event.data) as KlineMessage
          if (msg.e !== 'kline') return
          const k = msg.k

          const update: Kline = {
            openTime: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            closeTime: k.T,
          }

          setKlines((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.openTime !== update.openTime) {
              // New candle opened — append
              return [...prev.slice(-999), update]
            }
            // Same candle updated — replace last
            return [...prev.slice(0, -1), update]
          })
        } catch {
          // ignore malformed messages
        }
      }

      ws.onerror = () => {}

      ws.onclose = () => {
        if (!mountedRef.current || timeout) return
        hostIndex += 1
        timeout = setTimeout(() => {
          timeout = undefined
          connect()
        }, 2000)
      }
    }

    connect()

    return () => {
      mountedRef.current = false
      if (timeout) clearTimeout(timeout)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.onerror = null
        wsRef.current.onmessage = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [symbol, interval])

  return { klines, isLoading, error }
}