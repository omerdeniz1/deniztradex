import { describe, expect, it } from 'vitest'
import {
  VIRTUAL_AMM_FEE_RATE,
  quoteVirtualBuy,
  quoteVirtualSell,
  seedPrice,
} from '@/engine/virtualAmm'

const ENTES = { symbol: 'ENTES', reserveUsdt: 50000000, reserveToken: 5000000 }

describe('virtualAmm seed fiyatları', () => {
  it('rezerv oranları seed fiyatlarını verir', () => {
    expect(seedPrice(50000000, 5000000)).toBe(10)
    expect(seedPrice(30000000, 300000)).toBe(100)
    expect(seedPrice(20000000, 1000000)).toBe(20)
    expect(seedPrice(1000000, 100000000)).toBeCloseTo(0.01, 10)
    expect(seedPrice(800000, 26666666)).toBeCloseTo(0.03, 8)
    expect(seedPrice(500000, 100000000)).toBeCloseTo(0.005, 10)
  })
})

describe('quoteVirtualBuy', () => {
  it('küçük alımda fiyat ~rezerv oranına yakındır (ücret hariç)', () => {
    const q = quoteVirtualBuy(ENTES, 100)
    // Ücretsiz karşılığı 10 token; %0.3 ücretle biraz altı çıkar.
    expect(q.tokenAmount).toBeLessThan(10)
    expect(q.tokenAmount).toBeGreaterThan(10 * (1 - VIRTUAL_AMM_FEE_RATE) - 0.001)
    expect(q.usdtAmount).toBe(100)
    expect(q.oldPrice).toBe(10)
  })

  it('alım fiyatı yukarı iter (arz-talep)', () => {
    const q = quoteVirtualBuy(ENTES, 1000000)
    expect(q.newPrice).toBeGreaterThan(q.oldPrice)
    expect(q.priceImpactPct).toBeGreaterThan(0)
  })

  it('k sabitini ücret kadar büyütür, küçültmez', () => {
    const q = quoteVirtualBuy(ENTES, 1000000)
    const kBefore = ENTES.reserveUsdt * ENTES.reserveToken
    const kAfter = q.newReserveUsdt * q.newReserveToken
    expect(kAfter).toBeGreaterThanOrEqual(kBefore)
  })

  it('geçersiz tutarı reddeder', () => {
    expect(() => quoteVirtualBuy(ENTES, 0)).toThrow('Geçersiz tutar.')
    expect(() => quoteVirtualBuy(ENTES, -5)).toThrow('Geçersiz tutar.')
  })
})

describe('quoteVirtualSell', () => {
  it('satış fiyatı aşağı iter', () => {
    const q = quoteVirtualSell(ENTES, 10000)
    expect(q.newPrice).toBeLessThan(q.oldPrice)
    expect(q.priceImpactPct).toBeLessThan(0)
    expect(q.usdtAmount).toBeGreaterThan(0)
    expect(q.tokenAmount).toBe(10000)
  })

  it('geçersiz tutarı reddeder', () => {
    expect(() => quoteVirtualSell(ENTES, 0)).toThrow('Geçersiz tutar.')
  })
})
