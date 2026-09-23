import { useEffect, useRef } from 'react'
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
 *
 * DÖNGÜ KORUMASI: yazım marketStore'u günceller → `tickers` nesnesi yenilenir →
 * bu effect tekrar koşar. Fiyatı değişmeyen sembole YENİDEN yazılmaz
 * (`last` ref'i); aksi halde sekme kilitlenir (sonsuz render döngüsü).
 */
export function useVirtualLivePrices(
  tickers: Record<string, Ticker>,
  virtualSymbols: ReadonlySet<string>,
) {
  const last = useRef<Record<string, number>>({})

  useEffect(() => {
    const ingest = useMarketStore.getState().ingestLiveTicker
    for (const [key, t] of Object.entries(tickers)) {
      if (!t || !(t.price > 0)) continue
      if (!virtualSymbols.has(key.toUpperCase())) continue
      if (last.current[key] === t.price) continue
      last.current[key] = t.price
      ingest(t)
    }
  }, [tickers, virtualSymbols])
}
