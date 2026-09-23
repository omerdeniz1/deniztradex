import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMarketStore } from '@/store/marketStore'
import { useVirtualLivePrices } from '@/hooks/useVirtualLivePrices'
import type { Ticker } from '@/types'

const ENTES: Ticker = { symbol: 'ENTES', price: 10, change24h: 0, changePercent24h: 0, volume24h: 5 }
const BTC: Ticker = { symbol: 'BTCUSDT', price: 64000, change24h: 0, changePercent24h: 0, volume24h: 1 }

beforeEach(() => {
  localStorage.clear()
  useMarketStore.getState().resetMarket()
})

describe('useVirtualLivePrices', () => {
  it('sanal fiyatı livePrices haritasına işler, gerçeğe dokunmaz', () => {
    const vs = new Set(['ENTES'])
    renderHook(({ tickers }) => useVirtualLivePrices(tickers, vs), {
      initialProps: { tickers: { ENTES, BTCUSDT: BTC } },
    })
    const live = useMarketStore.getState().livePrices
    expect(live.ENTES).toBe(10)
    expect('BTCUSDT' in live).toBe(false)
  })

  it('fiyat değişmeyince YENİDEN yazmaz (sonsuz döngü koruması)', () => {
    const vs = new Set(['ENTES'])
    const { rerender } = renderHook(({ tickers }) => useVirtualLivePrices(tickers, vs), {
      initialProps: { tickers: { ENTES } },
    })
    const before = useMarketStore.getState().livePrices
    // Yeni nesne kimliği, aynı fiyat → store referansı korunmalı.
    rerender({ tickers: { ENTES: { ...ENTES } } })
    expect(useMarketStore.getState().livePrices).toBe(before)
  })

  it('fiyat değişince yeniden işler', () => {
    const vs = new Set(['ENTES'])
    const { rerender } = renderHook(({ tickers }) => useVirtualLivePrices(tickers, vs), {
      initialProps: { tickers: { ENTES } },
    })
    rerender({ tickers: { ENTES: { ...ENTES, price: 10.5 } } })
    expect(useMarketStore.getState().livePrices.ENTES).toBe(10.5)
  })
})
