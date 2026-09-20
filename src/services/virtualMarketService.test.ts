import { beforeEach, describe, expect, it } from 'vitest'
import {
  bucketVirtualKlines,
  executeVirtualTrade,
  getVirtualHoldings,
  listVirtualCoins,
  listVirtualKlines,
  VIRTUAL_SEED,
} from '@/services/virtualMarketService'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore } from '@/store/dnzStore'
import type { Kline } from '@/types'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useDnzStore.getState().resetDnz()
  // Yerel oturum: servis userId ister.
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_test', username: 'tester', email: 't@x.com', createdAt: 1 }),
  )
})

describe('virtualMarketService (yerel motor)', () => {
  it('7 seed coini seed fiyatlarıyla listeler (DNZ dahil)', async () => {
    const coins = await listVirtualCoins()
    expect(coins).toHaveLength(7)
    expect(coins.map((c) => c.symbol)).toEqual(VIRTUAL_SEED.map((s) => s.symbol))
    const entes = coins.find((c) => c.symbol === 'ENTES')!
    expect(entes.price).toBe(10)
    expect(entes.type).toBe('crypto')
    expect(coins.find((c) => c.symbol === 'V-XAU')!.type).toBe('commodity')
    // DNZ: 100M USDT / 200M arz → $0.50 açılış.
    const dnz = coins.find((c) => c.symbol === 'DNZ')!
    expect(dnz.price).toBeCloseTo(0.5)
    expect(dnz.type).toBe('crypto')
  })

  it('DNZ alış/satışı dnz defterine işler, havuzu oynatır', async () => {
    useTradeStore.setState({ balance: 1000 })
    const buy = await executeVirtualTrade('DNZ', 'buy', 100)
    expect(buy.tokenAmount).toBeGreaterThan(190)
    expect(buy.tokenAmount).toBeLessThan(200)
    expect(buy.newPrice).toBeGreaterThan(buy.price)
    expect(buy.priceImpactPct).toBeGreaterThan(0)
    expect(useDnzStore.getState().balance).toBeCloseTo(buy.tokenAmount, 6)
    const sell = await executeVirtualTrade('DNZ', 'sell', buy.tokenAmount / 2)
    expect(sell.usdtAmount).toBeGreaterThan(0)
    expect(useDnzStore.getState().balance).toBeCloseTo(buy.tokenAmount / 2, 4)
  })

  it('getVirtualHoldings DNZyi dnz defterinden birleştirir (satışta görünür)', async () => {
    useDnzStore.getState().buyDnz({ qty: 25, price: 0.5, usdtCost: 12.5 })
    const held = await getVirtualHoldings()
    expect(held['DNZ']).toBeCloseTo(25)
    useDnzStore.getState().resetDnz()
    const empty = await getVirtualHoldings()
    expect(empty['DNZ']).toBeUndefined()
  })

  it('alış bakiyeyi düşürür, token verir, fiyatı yukarı iter', async () => {
    useTradeStore.setState({ balance: 1000 })
    const res = await executeVirtualTrade('ENTES', 'buy', 100)

    expect(res.tokenAmount).toBeGreaterThan(0)
    expect(res.tokenAmount).toBeLessThan(10) // ücret kesintisi
    expect(res.newPrice).toBeGreaterThan(res.price)
    expect(useTradeStore.getState().balance).toBeCloseTo(900)

    const holdings = await getVirtualHoldings()
    expect(holdings.ENTES).toBeCloseTo(res.tokenAmount, 8)

    const coins = await listVirtualCoins()
    expect(coins.find((c) => c.symbol === 'ENTES')!.price).toBeCloseTo(res.newPrice, 8)
  })

  it('satış token düşürür, USDT verir', async () => {
    useTradeStore.setState({ balance: 1000 })
    const bought = await executeVirtualTrade('RGC', 'buy', 100)
    const res = await executeVirtualTrade('RGC', 'sell', bought.tokenAmount)

    expect(res.usdtAmount).toBeGreaterThan(0)
    // Alış+satış ücretleri nedeniyle gelen, gidenden azdır.
    expect(res.usdtAmount).toBeLessThan(100)
    const holdings = await getVirtualHoldings()
    expect(holdings.RGC ?? 0).toBe(0)
  })

  it('yetersiz bakiyeleri reddeder', async () => {
    useTradeStore.setState({ balance: 10 })
    await expect(executeVirtualTrade('ENTES', 'buy', 100)).rejects.toThrow('USDT')
    await expect(executeVirtualTrade('ENTES', 'sell', 5)).rejects.toThrow('coin')
    await expect(executeVirtualTrade('NOPE', 'buy', 10)).rejects.toThrow('bulunamadı')
    await expect(executeVirtualTrade('ENTES', 'buy', 0)).rejects.toThrow('Geçersiz tutar.')
  })
})

describe('bucketVirtualKlines', () => {
  function m1(n: number, base = 100): Kline[] {
    return Array.from({ length: n }, (_, i) => ({
      openTime: i * 60000,
      open: base + i,
      high: base + i + 0.5,
      low: base + i - 0.5,
      close: base + i + 0.25,
      volume: 10,
      closeTime: i * 60000 + 59999,
    }))
  }

  it('1m aynen gecer', () => {
    expect(bucketVirtualKlines(m1(5), '1m')).toHaveLength(5)
  })

  it('5m beserli katlar (open ilk, close son, high/low uclar)', () => {
    const out = bucketVirtualKlines(m1(10), '5m')
    expect(out).toHaveLength(2)
    expect(out[0].open).toBe(100)
    expect(out[0].close).toBe(104.25)
    expect(out[0].high).toBe(104.5)
    expect(out[0].low).toBe(99.5)
    expect(out[0].volume).toBe(50)
  })
})

describe('listVirtualKlines (yerel sentetik)', () => {
  it('havuz fiyatina biten sirali mumlar uretir', async () => {
    const klines = await listVirtualKlines('ENTES', '1m', 50)
    expect(klines).toHaveLength(50)
    for (let i = 1; i < klines.length; i++) {
      expect(klines[i].openTime).toBeGreaterThan(klines[i - 1].openTime)
    }
    const last = klines[klines.length - 1]
    expect(last.close).toBeCloseTo(10, 6)
    for (const k of klines) {
      expect(k.high).toBeGreaterThanOrEqual(Math.max(k.open, k.close))
      expect(k.low).toBeLessThanOrEqual(Math.min(k.open, k.close))
    }
  })

  it('ust zaman dilimine katlanmis doner', async () => {
    const klines = await listVirtualKlines('ENTES', '5m', 20)
    expect(klines.length).toBeLessThanOrEqual(20)
    expect(klines.length).toBeGreaterThan(0)
  })
})
