import type { Interval, Kline, TradingMode } from '@/types'

/**
 * Binance hosts are geo-restricted in some regions (the `.com` domains return
 * HTTP 451 there). The `*.binance.vision` mirrors are public market-data hosts
 * that keep working in restricted regions, so every request tries the primary
 * host first and falls back to the mirror automatically.
 */
export const SPOT_REST_BASES = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
]

export const FUTURES_REST_BASE = 'https://fapi.binance.com'

export const WS_HOSTS = [
  'wss://stream.binance.com:9443',
  'wss://data-stream.binance.vision',
]

/**
 * In development the Vite dev server proxies Binance REST + WebSocket traffic,
 * which lets a browser run the app on localhost without CORS restrictions.
 * Tests run under vitest (`import.meta.env.MODE === 'test'`), so the proxy is
 * only active for the real dev server — never for tests or production builds.
 */
export const USE_BINANCE_PROXY = import.meta.env.DEV && import.meta.env.MODE !== 'test'

const REST_PROXY_MAP: Record<string, string> = {
  'https://api.binance.com': '/binance-spot',
  'https://data-api.binance.vision': '/binance-spot-mirror',
  'https://fapi.binance.com': '/binance-futures',
}

const WS_PROXY_MAP: Record<string, string> = {
  'wss://stream.binance.com:9443': '/binance-ws',
  'wss://data-stream.binance.vision': '/binance-ws-mirror',
}

/** Resolve a REST base to its dev-proxy path (or keep the origin URL). */
export function restBase(b: string): string {
  return USE_BINANCE_PROXY ? (REST_PROXY_MAP[b] ?? b) : b
}

/** Resolve a WebSocket host to its dev-proxy path (or keep the origin URL). */
export function wsHost(h: string): string {
  return USE_BINANCE_PROXY ? (WS_PROXY_MAP[h] ?? h) : h
}

const SPOT_24HR = '/api/v3/ticker/24hr'
const FUTURES_24HR = '/fapi/v1/ticker/24hr'

const DEFAULT_SYMBOL = 'BTCUSDT'

const MAX_KLINES = 1000

/** Shape of a row from Binance /ticker/24hr (REST). */
export interface RawTicker24h {
  symbol: string
  lastPrice: string
  priceChange: string
  priceChangePercent: string
  volume: string
}

interface RawKlineRow extends Array<number | string> {
  0: number
  1: string
  2: string
  3: string
  4: string
  5: string
  6: number
}

function parseKlines(rows: RawKlineRow[]): Kline[] {
  return rows.map((r) => ({
    openTime: r[0] as number,
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5]),
    closeTime: r[6] as number,
  }))
}

async function getFirst(bases: string[], path: string): Promise<RawTicker24h[]> {
  for (const base of bases) {
    try {
      const res = await fetch(`${restBase(base)}${path}`)
      if (!res.ok) continue
      const data = (await res.json()) as RawTicker24h[]
      if (Array.isArray(data) && data.length) return data
    } catch {
      // try next host
    }
  }
  return []
}

/** Full spot 24h snapshot (hundreds of pairs), falling back to the mirror host. */
export function fetchSpot24hTickers(): Promise<RawTicker24h[]> {
  return getFirst(SPOT_REST_BASES, SPOT_24HR)
}

/** Full USDT-M futures 24h snapshot — used when the spot snapshot is empty. */
export function fetchFutures24hTickers(): Promise<RawTicker24h[]> {
  return getFirst([FUTURES_REST_BASE], FUTURES_24HR)
}

export async function fetchKlines(
  mode: TradingMode,
  symbol: string = DEFAULT_SYMBOL,
  interval: Interval = '1m',
  limit = MAX_KLINES,
): Promise<Kline[]> {
  const bases = mode === 'futures' ? [FUTURES_REST_BASE] : SPOT_REST_BASES
  const endpoint = mode === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines'
  const params = `?symbol=${symbol}&interval=${interval}&limit=${limit}`

  for (const base of bases) {
    try {
      const res = await fetch(`${restBase(base)}${endpoint}${params}`)
      if (!res.ok) continue
      const data = (await res.json()) as RawKlineRow[]
      if (Array.isArray(data)) return parseKlines(data)
    } catch {
      // try next host
    }
  }
  throw new Error(`Binance API klines unavailable for ${symbol}`)
}

export function getWsUrl(
  symbol: string,
  stream: 'ticker' | 'kline',
  hostIndex = 0,
  interval: Interval = '1m',
): string {
  const host = wsHost(WS_HOSTS[hostIndex % WS_HOSTS.length])
  const lower = symbol.toLowerCase()
  // Canlı mum güncellemeleri seçili zaman diliminden gelir (örn. 1H
  // seçiliyken `btcusdt@kline_1h`), yoksa grafik 1m mumlarla kirlenir.
  const streamName = stream === 'ticker' ? `${lower}@ticker` : `${lower}@kline_${interval}`
  return `${host}/ws/${streamName}`
}

export function getSymbolMarket(mode: TradingMode): string {
  return mode === 'futures' ? 'FUTURES' : 'SPOT'
}

/** Shape of a Binance /ticker/price response for a single symbol. */
export interface RawSymbolPrice {
  symbol: string
  price: string
}

/** Tek bir spot sembolünün anlık fiyatı (örn. USDTTRY) — yedek hosta düşer. */
export async function fetchSymbolPrice(
  symbol: string,
): Promise<RawSymbolPrice | null> {
  const path = `/api/v3/ticker/price?symbol=${symbol}`
  for (const base of SPOT_REST_BASES) {
    try {
      const res = await fetch(`${restBase(base)}${path}`)
      if (!res.ok) continue
      const data = (await res.json()) as RawSymbolPrice
      if (data?.symbol && data?.price) return data
    } catch {
      // try next host
    }
  }
  return null
}