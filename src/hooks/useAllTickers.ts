import { useEffect } from 'react'
import {
  fetchFutures24hTickers,
  fetchSpot24hTickers,
  WS_HOSTS,
  wsHost,
} from '@/services/binance'
import { useMarketStore } from '@/store/marketStore'
import type { Ticker } from '@/types'

export type { MarketStatus } from '@/store/marketStore'
export { FALLBACK_PAIR_SYMBOLS } from '@/store/marketStore'

/**
 * Live market feed — a SINGLE WebSocket connection for the whole app
 * (`!ticker@arr` on the combined stream endpoint), feeding the global
 * `tickers` store (full 24h rows). Pair-selector, watchlists and 24h
 * stats read from `tickers`; the critical price column in the header and
 * the open-positions table reads from the dedicated per-symbol `livePrices`
 * feed (`useLivePrices`), so no two views ever drift apart.
 *
 * Resilience:
 * - Auto-reconnect: `onerror` AND `onclose` schedule a new socket after 2s.
 * - Host rotation: a socket that refuses to open within 8s (geo-blocked host
 *   that hangs instead of rejecting) is rotated to the next host.
 * - One-time REST snapshot seeds `tickers` on startup to cover the seconds
 *   before the socket warms up; while the socket stays down it is re-seeded
 *   every 15s so the UI never stalls frozen on the initial values.
 */

interface RawTicker {
  s?: string
  c?: string
  p?: string
  P?: string
  v?: string
  symbol?: string
  lastPrice?: string
  priceChange?: string
  priceChangePercent?: string
  volume?: string
}

/** Reconnect delay after a socket dies (onerror/onclose). */
const RECONNECT_DELAY_MS = 2000

/** If a socket has not opened within this long, rotate to the next host. */
const WS_OPEN_TIMEOUT_MS = 8000

/** While disconnected, refresh the REST seed at most this often. */
const STALE_RESEED_MS = 15_000

const setStatus = (status: 'loading' | 'live' | 'offline') =>
  useMarketStore.getState().setStatus(status)

/** Functional state update — merges, never replaces the existing map. */
const ingest = (map: Record<string, Ticker>) =>
  useMarketStore.getState().setTickers(map)

function parseRaw(raw: RawTicker): Ticker | null {
  const price = parseFloat(raw.c ?? raw.lastPrice ?? '')
  if (!Number.isFinite(price) || price <= 0) return null
  const changePercent = parseFloat(raw.P ?? raw.priceChangePercent ?? '')
  return {
    symbol: raw.s ?? raw.symbol ?? '',
    price,
    change24h: parseFloat(raw.p ?? raw.priceChange ?? '') || 0,
    changePercent24h: Number.isFinite(changePercent) ? changePercent : 0,
    volume24h: parseFloat(raw.v ?? raw.volume ?? '') || 0,
  }
}

function builtInTickers(rows: RawTicker[]): Record<string, Ticker> | null {
  const next: Record<string, Ticker> = {}
  for (const row of rows) {
    if (!row?.s && !row?.symbol) continue
    const symbol = String(row.s ?? row.symbol)
    if (!symbol.endsWith('USDT')) continue
    const parsed = parseRaw(row)
    if (parsed) next[parsed.symbol] = parsed
  }
  return Object.keys(next).length ? next : null
}

// --- Singleton socket manager (module scope → exactly one connection) ---

let streamStarted = false
let streamGeneration = 0
let wsRef: WebSocket | null = null
let wsHostIndex = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let lastSeedAt = 0

/** Start the single app-wide market feed (idempotent). */
export function ensureMarketStream() {
  if (streamStarted) return
  streamStarted = true
  void seedSnapshot()
  connect()
}

/** Teardown used by tests so each test starts from a clean feed. */
export function resetMarketStream() {
  streamGeneration += 1
  streamStarted = false
  lastSeedAt = 0
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  if (wsRef) {
    wsRef.onclose = null
    wsRef.onerror = null
    wsRef.onmessage = null
    wsRef.close()
    wsRef = null
  }
  useMarketStore.getState().resetMarket()
}

/**
 * One-time REST seed: fetch the current spot snapshot (futures as fallback)
 * into `livePrices` so there is no empty/frozen window while the socket warms.
 */
async function seedSnapshot() {
  const gen = streamGeneration
  lastSeedAt = Date.now()
  let rows = await fetchSpot24hTickers()
  if (!rows.length) rows = await fetchFutures24hTickers()
  if (gen !== streamGeneration) return
  const map = builtInTickers(rows)
  if (map) ingest(map)
}

/** Schedule a single reconnect (guarded, so error+close never double it). */
function scheduleReconnect() {
  if (reconnectTimer) return
  setStatus('offline')
  wsHostIndex += 1
  if (Date.now() - lastSeedAt > STALE_RESEED_MS) void seedSnapshot()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    connect()
  }, RECONNECT_DELAY_MS)
}

function connect() {
  let ws: WebSocket
  try {
    const host = wsHost(WS_HOSTS[wsHostIndex % WS_HOSTS.length])
    ws = new WebSocket(`${host}/stream?streams=!ticker@arr`)
  } catch {
    scheduleReconnect()
    return
  }
  wsRef = ws

  let opened = false
  const hangTimer = window.setTimeout(() => {
    if (opened) return
    ws.close()
  }, WS_OPEN_TIMEOUT_MS)

  ws.onopen = () => {
    opened = true
    window.clearTimeout(hangTimer)
    setStatus('live')
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as {
        data?: RawTicker[]
        stream?: string
      }
      if (Array.isArray(msg.data)) {
        const map = builtInTickers(msg.data)
        if (map) ingest(map)
      }
    } catch {
      // ignore malformed frames
    }
  }

  ws.onerror = () => {
    // Some brokers fire error then close; closing here funnels everything
    // through the single onclose → reconnect path.
    window.clearTimeout(hangTimer)
    if (opened || reconnectTimer) return
    try {
      ws.close()
    } catch {
      // already closed — fall through
    }
    scheduleReconnect()
  }

  ws.onclose = () => {
    window.clearTimeout(hangTimer)
    if (wsRef === ws) wsRef = null
    scheduleReconnect()
  }
}

/** Read the shared 24h feed. The stream itself is started once app-wide. */
export function useAllTickers() {
  useEffect(() => {
    ensureMarketStream()
  }, [])

  const tickers = useMarketStore((s) => s.tickers)
  const status = useMarketStore((s) => s.status)
  return { tickers, status }
}