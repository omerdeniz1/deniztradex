import { useEffect, useMemo, useState } from 'react'
import { useAllTickers } from '@/hooks/useAllTickers'
import {
  listVirtual24hChanges,
  listVirtualCoins,
  VIRTUAL_SEED,
  type VirtualChange,
  type VirtualCoin,
} from '@/services/virtualMarketService'
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
  // Sanal coin 24s değişimleri: mum kapanışlarından hesaplanır (0 değil).
  const [virtualChanges, setVirtualChanges] = useState<Record<string, VirtualChange>>({})

  useEffect(() => {
    let live = true
    const load = () => {
      void listVirtualCoins().then((list) => {
        if (live) setVirtualCoins(list)
      })
      void listVirtual24hChanges().then((map) => {
        if (live) setVirtualChanges(map)
      })
    }
    load()
    // Oto-bot hamleleri listeye hızlı düşsün diye 15 sn yoklama.
    const timer = window.setInterval(load, 15000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])

  const merged = useMemo(() => {
    const out: Record<string, Ticker> = { ...tickers }
    for (const c of virtualCoins) {
      const ch = virtualChanges[c.symbol.toUpperCase()]
      out[c.symbol] = {
        symbol: c.symbol,
        price: c.price,
        change24h: ch?.change ?? 0,
        changePercent24h: ch?.changePct ?? 0,
        volume24h: c.volume24h,
      }
    }
    return out
  }, [tickers, virtualCoins, virtualChanges])

  const virtualSymbols = useMemo(
    () => new Set(virtualCoins.map((c) => c.symbol.toUpperCase())),
    [virtualCoins],
  )

  return { tickers: merged, virtualSymbols, status }
}
