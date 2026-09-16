import { useEffect, useState } from 'react'
import { fetchFuturesSymbols } from '@/services/binance'

/**
 * Vadeli kontrat kümesi (USDT-M perpetual, TRADING).
 *
 * - `null` = henüz bilinmiyor / alınamadı → menüler filtre UYGULAMAZ
 *   (fail-open: çevrimdışıyken liste boş kalmaz).
 * - Dolu küme = vadeli menüler (PairSelector) yalnızca bunları listeler.
 *
 * Sonuç modül düzeyinde önbelleğe alınır (exchangeInfo ~1MB, tek sefer
 * yeter); testler `resetFuturesSymbolsCache` ile sıfırlar.
 */
let cache: Promise<Set<string>> | null = null

export function resetFuturesSymbolsCache(): void {
  cache = null
}

export function useFuturesSymbols(): Set<string> | null {
  const [symbols, setSymbols] = useState<Set<string> | null>(null)

  useEffect(() => {
    let live = true
    if (!cache) {
      cache = fetchFuturesSymbols().catch(() => new Set<string>())
    }
    void cache.then((s) => {
      if (live) setSymbols(s.size > 0 ? s : null)
    })
    return () => {
      live = false
    }
  }, [])

  return symbols
}
