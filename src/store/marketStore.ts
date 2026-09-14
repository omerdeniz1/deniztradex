import { create } from 'zustand'
import type { Ticker } from '@/types'

export type MarketStatus = 'loading' | 'live' | 'offline'

/** Market always kept visible, even before/without a live connection. */
export const FALLBACK_PAIR_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'DOGEUSDT',
  'XRPUSDT',
  'AVAXUSDT',
  'PEPEUSDT',
  'ADAUSDT',
] as const

const FALLBACK_PRICES: Record<string, number> = {
  BTCUSDT: 64000,
  ETHUSDT: 3400,
  SOLUSDT: 160,
  DOGEUSDT: 0.12,
  XRPUSDT: 0.55,
  AVAXUSDT: 28,
  PEPEUSDT: 0.000008,
  ADAUSDT: 0.45,
}

/** Plausible 24h moves so the offline snapshot never looks "frozen at +0%". */
const FALLBACK_CHANGES: Record<string, number> = {
  BTCUSDT: 1.42,
  ETHUSDT: -0.86,
  SOLUSDT: 2.57,
  DOGEUSDT: -1.24,
  XRPUSDT: 0.73,
  AVAXUSDT: -0.55,
  PEPEUSDT: 3.18,
  ADAUSDT: -1.07,
}

export const FALLBACK_TICKERS: Record<string, Ticker> = Object.fromEntries(
  FALLBACK_PAIR_SYMBOLS.map((s) => {
    const price = FALLBACK_PRICES[s] ?? 0
    const changePercent24h = FALLBACK_CHANGES[s] ?? 0
    return [
      s,
      {
        symbol: s,
        price,
        change24h: (price * changePercent24h) / 100,
        changePercent24h,
        volume24h: 0,
      },
    ]
  }),
)

interface MarketState {
  /**
   * Central live-price state (`livePrices`): the single source of truth for
   * the header ticker, chart panel and the open-positions Mark column. One
   * lightweight per-symbol `@ticker` socket writes directly into this map.
   * Values are the latest close prices (`data.c`).
   */
  livePrices: Record<string, number>
  /**
   * Full 24h ticker objects for browse lists (markets / watchlist /
   * pair-picker) and 24h stats (24h high/low, volume, %).
   */
  tickers: Record<string, Ticker>
  status: MarketStatus
  /** Bulk merge full 24h rows (all-market feed). */
  setTickers: (map: Record<string, Ticker>) => void
  /** Write a single live price + full row in one functional set. */
  ingestLiveTicker: (ticker: Ticker) => void
  setStatus: (status: MarketStatus) => void
  resetMarket: () => void
}

export const useMarketStore = create<MarketState>((set) => ({
  livePrices: {},
  tickers: FALLBACK_TICKERS,
  status: 'loading',
  setTickers: (map) =>
    set((state) => ({
      tickers: { ...state.tickers, ...map },
      status: 'live',
    })),
  ingestLiveTicker: (ticker) =>
    set((state) => ({
      livePrices: { ...state.livePrices, [ticker.symbol]: ticker.price },
      tickers: { ...state.tickers, [ticker.symbol]: ticker },
      status: 'live',
    })),
  setStatus: (status) => set({ status }),
  resetMarket: () =>
    set({ livePrices: {}, tickers: FALLBACK_TICKERS, status: 'loading' }),
}))
