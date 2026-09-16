import { beforeEach, describe, expect, it } from 'vitest'
import {
  executeVirtualTrade,
  getVirtualHoldings,
  listVirtualCoins,
  VIRTUAL_SEED,
} from '@/services/virtualMarketService'
import { useTradeStore } from '@/store/tradeStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  // Yerel oturum: servis userId ister.
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_test', username: 'tester', email: 't@x.com', createdAt: 1 }),
  )
})

describe('virtualMarketService (yerel motor)', () => {
  it('6 seed coini seed fiyatlarıyla listeler', async () => {
    const coins = await listVirtualCoins()
    expect(coins).toHaveLength(6)
    expect(coins.map((c) => c.symbol)).toEqual(VIRTUAL_SEED.map((s) => s.symbol))
    const entes = coins.find((c) => c.symbol === 'ENTES')!
    expect(entes.price).toBe(10)
    expect(entes.type).toBe('crypto')
    expect(coins.find((c) => c.symbol === 'V-XAU')!.type).toBe('commodity')
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
