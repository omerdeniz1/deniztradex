import { useEffect } from 'react'
import { useMarketStore } from '@/store/marketStore'
import type { Ticker } from '@/types'

/**
 * Sanal coin fiyat beslemesi → vadeli motor.
 *
 * Binance soketi sanal sembollerde (ENTES, DNZ…) yoktur; yoklama ile gelen
 * birleşik ticker (15 sn) bu hook ile merkezi `livePrices` haritasına işlenir.
 * Böylece likidasyon watchdog'u, mark-price medyanı, TP/SL ve bekleyen emir
 * tetikleyicileri sanal kontratlarda GERÇEK kontratlarla aynı kodu çalıştırır.
 *
 * Yalnızca sanal semboller işlenir — gerçek Binance satırlarına dokunulmaz.
 */
export function useVirtualLivePrices(
  tickers: Record<string, Ticker>,
  virtualSymbols: ReadonlySet<string>,
) {
  useEffect(() => {
    const ingest = useMarketStore.getState().ingestLiveTicker
    for (const [key, t] of Object.entries(tickers)) {
      if (!t || t.price <= 0) continue
      if (!virtualSymbols.has(key.toUpperCase())) continue
      ingest(t)
    }
  }, [tickers, virtualSymbols])
}
