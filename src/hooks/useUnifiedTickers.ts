import { useEffect, useMemo, useState } from 'react'
import { useAllTickers } from '@/hooks/useAllTickers'
import { listVirtualCoins, VIRTUAL_SEED, type VirtualCoin } from '@/services/virtualMarketService'
import type { Ticker } from '@/types'

/**
 * Birleşik piyasa: Binance gerçek coinleri + Sanal Piyasa (AMM) tek map'te.
 *
 * Sanal coinler BTC/USDT satırıyla BİREBİR aynı `Ticker` formunda sunulur
 * (rozet/ayrım yok): sembol anahtar, fiyat havuzdan, hacim tablodan.
 * `virtualSymbols` hangi sembollerin grafiğini/işlemini sanal altyapının
 * üstlendiğini söyler.
 *
 * Sanal küme tohumdan SENKRON başlar: ilk render'da sanal semboller
 * bellidir, Binance'e boşa istek gitmez, panel/grafik beklemez.
 */
const SEED_COINS: VirtualCoin[] = VIRTUAL_SEED.map((s) => ({
  symbol: s.symbol,
  name: s.name,
  type: s.type,
  reserveUsdt: s.reserveUsdt,
  reserveToken: s.reserveToken,
  price: s.price,
  volume24h: 0,
}))

export function useUnifiedTickers() {
  const { tickers, status } = useAllTickers()
  const [virtualCoins, setVirtualCoins] = useState<VirtualCoin[]>(SEED_COINS)

  useEffect(() => {
    let live = true
    const load = () => {
      void listVirtualCoins().then((list) => {
        if (live) setVirtualCoins(list)
      })
    }
    load()
    const timer = window.setInterval(load, 30000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])

  const merged = useMemo(() => {
    const out: Record<string, Ticker> = { ...tickers }
    for (const c of virtualCoins) {
      out[c.symbol] = {
        symbol: c.symbol,
        price: c.price,
        change24h: 0,
        changePercent24h: 0,
        volume24h: c.volume24h,
      }
    }
    return out
  }, [tickers, virtualCoins])

  const virtualSymbols = useMemo(
    () => new Set(virtualCoins.map((c) => c.symbol.toUpperCase())),
    [virtualCoins],
  )

  return { tickers: merged, virtualSymbols, status }
}
