import { useEffect, useMemo, useRef } from 'react'
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
 * PERFORMANS NOTU: birleşik `tickers` nesnesi Binance akışıyla saniyede
 * birkaç kez yenilenir (binlerce kayıt). Effect doğrudan ona bağlanırsa her
 * seferinde tüm harita dönülür ve site ağırlaşır. Bunun yerine 7 sanal
 * sembolden ucuz bir imza çıkarılır; yazım YALNIZCA imza değişince
 * (15 sn yoklamada) koşar.
 *
 * DÖNGÜ KORUMASI: yazım marketStore'u günceller → `tickers` nesnesi yenilenir →
 * imza aynı kaldığı için effect tekrar koşmaz (sonsuz render yok).
 */
export function useVirtualLivePrices(
  tickers: Record<string, Ticker>,
  virtualSymbols: ReadonlySet<string>,
) {
  const last = useRef<Record<string, number>>({})

  const snapshot = useMemo(() => {
    const rows: Record<string, Ticker> = {}
    const parts: string[] = []
    for (const sym of virtualSymbols) {
      const t = tickers[sym]
      if (t && t.price > 0) {
        rows[sym] = t
        parts.push(`${sym}:${t.price}`)
      }
    }
    return { rows, sig: parts.join('|') }
  }, [tickers, virtualSymbols])

  const sig = snapshot.sig
  useEffect(() => {
    if (!sig) return
    const ingest = useMarketStore.getState().ingestLiveTicker
    for (const [sym, t] of Object.entries(snapshot.rows)) {
      if (last.current[sym] === t.price) continue
      last.current[sym] = t.price
      ingest(t)
    }
    // rows bilerek deps dışı: sig ile aynı memo'dan gelir, imza değişmeden
    // satırlar da değişmez (bkz. PERFORMANS NOTU).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}
