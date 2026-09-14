import { useEffect } from 'react'
import { WS_HOSTS, wsHost } from '@/services/binance'
import { useMarketStore } from '@/store/marketStore'
import type { Ticker } from '@/types'

/**
 * Lightweight per-symbol live prices.
 *
 * Instead of the heavy whole-market stream, one dedicated Binance `@ticker`
 * socket is kept for each actively watched symbol / open position:
 *   wss://<host>/ws/<symbol>@ticker   (lowercase symbol, e.g. lskusdt@ticker)
 *
 * Every incoming message writes straight into the central `livePrices` map
 * (functional update, so no other symbols are ever dropped):
 *   setLivePrices(prev => ({ ...prev, [SYMBOL]: parseFloat(data.c) }))
 *
 * Sockets for symbols that are no longer wanted are closed in a cleanup pass
 * — no stale sockets, no memory leaks.
 */

const RECONNECT_DELAY_MS = 2000

/** If a socket has not opened within this long, rotate to the next host. */
const WS_OPEN_TIMEOUT_MS = 8000

interface RawPrice {
  s?: string
  c?: string
  p?: string
  P?: string
  v?: string
}

const sockets = new Map<string, WebSocket>()
const hostIndexes = new Map<string, number>()
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
const hangTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimers(symbol: string) {
  const rt = reconnectTimers.get(symbol)
  if (rt) {
    clearTimeout(rt)
    reconnectTimers.delete(symbol)
  }
  const ht = hangTimers.get(symbol)
  if (ht) {
    clearTimeout(ht)
    hangTimers.delete(symbol)
  }
}

/** Close the socket for one symbol (and any pending reconnect/hang timers). */
export function closeLivePriceSocket(symbol: string) {
  clearTimers(symbol)
  const ws = sockets.get(symbol)
  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
    sockets.delete(symbol)
  }
}

function openLivePriceSocket(symbol: string) {
  if (sockets.has(symbol) || reconnectTimers.has(symbol)) return
  const hostIdx = hostIndexes.get(symbol) ?? 0
  const url = `${wsHost(WS_HOSTS[hostIdx % WS_HOSTS.length])}/ws/${symbol.toLowerCase()}@ticker`
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    return
  }
  sockets.set(symbol, ws)

  let opened = false
  const hangTimer = window.setTimeout(() => {
    if (opened) return
    if (sockets.get(symbol) === ws) ws.close()
  }, WS_OPEN_TIMEOUT_MS)
  hangTimers.set(symbol, hangTimer)

  ws.onopen = () => {
    opened = true
    clearTimers(symbol)
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data)) as RawPrice
      if (typeof data.s !== 'string' || typeof data.c !== 'string') return
      // DEBUG: live-feed verification in the F12 console
      console.log('Gelen Fiyat:', data.s, data.c)
      const price = parseFloat(data.c)
      if (!Number.isFinite(price) || price <= 0) return
      const ticker: Ticker = {
        symbol: data.s,
        price,
        change24h: parseFloat(data.p ?? '') || 0,
        changePercent24h: parseFloat(data.P ?? '') || 0,
        volume24h: parseFloat(data.v ?? '') || 0,
      }
      useMarketStore.getState().ingestLiveTicker(ticker)
    } catch {
      // ignore malformed frames
    }
  }

  const fail = () => {
    if (sockets.get(symbol) !== ws) return
    clearTimers(symbol)
    sockets.delete(symbol)
    if (reconnectTimers.has(symbol)) return
    hostIndexes.set(symbol, (hostIndexes.get(symbol) ?? 0) + 1)
    reconnectTimers.set(
      symbol,
      setTimeout(() => {
        reconnectTimers.delete(symbol)
        openLivePriceSocket(symbol)
      }, RECONNECT_DELAY_MS),
    )
  }

  ws.onerror = () => {
    // Funnel error + close through the single onclose → reconnect path.
    if (sockets.get(symbol) !== ws) return
    try {
      ws.close()
    } catch {
      // already closed — fall through
    }
  }

  ws.onclose = fail
}

/** Test hook: teardown every per-symbol socket (close all, clear timers). */
export function resetLivePriceStream() {
  for (const symbol of Array.from(sockets.keys())) closeLivePriceSocket(symbol)
  hostIndexes.clear()
}

/**
 * Subscribe the given symbols to their own lightweight `@ticker` streams and
 * return the shared `livePrices` map (latest close prices).
 */
export function useLivePrices(symbols: string[]) {
  const livePrices = useMarketStore((s) => s.livePrices)

  useEffect(() => {
    const next = new Set(
      symbols
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
    )
    for (const s of next) {
      if (!sockets.has(s)) openLivePriceSocket(s)
    }
    for (const s of Array.from(sockets.keys())) {
      if (!next.has(s)) closeLivePriceSocket(s)
    }
  }, [symbols])

  // Unmount: close every per-symbol socket (its own effect is deps-driven, so
  // this cleanup only ever runs on unmount).
  useEffect(() => {
    return () => {
      for (const s of Array.from(sockets.keys())) closeLivePriceSocket(s)
    }
  }, [])

  return livePrices
}