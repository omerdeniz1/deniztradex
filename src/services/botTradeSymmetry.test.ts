import { beforeEach, describe, expect, it } from 'vitest'
import {
  executeBotPoolTrade,
  listVirtualCoins,
} from '@/services/virtualMarketService'

/**
 * Bot hamle simetrisi — 50/50 bot akışının fiyatı tek yöne kaydırmaması
 * için alış/satış bacakları birbirinin aynası olmalı (net tutar kuralı).
 * Eski brüt-satış kuralı tur başına `a·f` USDT sızdırıp coinleri
 * sistematik düşürüyordu; bu test o regresyonu deterministik yakalar.
 */
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_sym', username: 'sym', email: 's@x.com', createdAt: 1 }),
  )
})

async function priceOf(symbol: string): Promise<number> {
  const coins = await listVirtualCoins()
  const c = coins.find((x) => x.symbol === symbol)
  if (!c) throw new Error(`Coin bulunamadı: ${symbol}`)
  return c.price
}

describe('executeBotPoolTrade simetrisi (yerel motor)', () => {
  it.each([
    { symbol: 'ENTES', amount: 1000 },
    { symbol: 'SVGC', amount: 500 },
    { symbol: 'V-XAU', amount: 5000 },
    { symbol: 'RGC', amount: 100 },
  ])('alım→satış turu fiyatı $symbol için iade eder (%$amount)', async ({ symbol, amount }) => {
    const p0 = await priceOf(symbol)
    await executeBotPoolTrade(symbol, 'buy', amount, { localOnly: true })
    const p1 = await priceOf(symbol)
    expect(p1).toBeGreaterThan(p0)
    await executeBotPoolTrade(symbol, 'sell', amount, { localOnly: true })
    const p2 = await priceOf(symbol)
    expect(Math.abs((p2 - p0) / p0)).toBeLessThan(1e-9)
  })

  it.each([
    { symbol: 'ENTES', amount: 1000 },
    { symbol: 'SVGC', amount: 500 },
  ])('satış→alım turu fiyatı $symbol için iade eder (%$amount)', async ({ symbol, amount }) => {
    const p0 = await priceOf(symbol)
    await executeBotPoolTrade(symbol, 'sell', amount, { localOnly: true })
    const p1 = await priceOf(symbol)
    expect(p1).toBeLessThan(p0)
    await executeBotPoolTrade(symbol, 'buy', amount, { localOnly: true })
    const p2 = await priceOf(symbol)
    expect(Math.abs((p2 - p0) / p0)).toBeLessThan(1e-9)
  })

  it('satış yön işareti korunur (alım +, satış −)', async () => {
    const buy = await executeBotPoolTrade('MPRC', 'buy', 200, { localOnly: true })
    expect(buy.priceImpactPct).toBeGreaterThan(0)
    const sell = await executeBotPoolTrade('MPRC', 'sell', 200, { localOnly: true })
    expect(sell.priceImpactPct).toBeLessThan(0)
  })
})
