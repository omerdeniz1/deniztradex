import { describe, expect, it } from 'vitest'
import { DNZ_FEE_DISCOUNT, quoteSpotFee, roundFee, SPOT_FEE_RATE } from '@/engine/fees'

describe('quoteSpotFee', () => {
  it('standart komisyonu işlem tutarının %0.1i olarak hesaplar', () => {
    const q = quoteSpotFee(1000, { payWithDnz: false, dnzBalance: 0, dnzPrice: 0.5 })
    expect(SPOT_FEE_RATE).toBe(0.001)
    expect(q.feeUsdt).toBeCloseTo(1)
    expect(q.useDnz).toBe(false)
    expect(q.usdtCharge).toBeCloseTo(1)
    expect(q.feeDnz).toBe(0)
  })

  it('DNZ ile ödemede %25 indirim uygular', () => {
    expect(DNZ_FEE_DISCOUNT).toBe(0.25)
    // 1000 USDT işlem → 1 USDT komisyon → indirimli 0.75 USDT → 0.5 fiyattan 1.5 DNZ.
    const q = quoteSpotFee(1000, { payWithDnz: true, dnzBalance: 10, dnzPrice: 0.5 })
    expect(q.useDnz).toBe(true)
    expect(q.discountedUsdt).toBeCloseTo(0.75)
    expect(q.feeDnz).toBeCloseTo(1.5)
    expect(q.usdtCharge).toBe(0)
  })

  it('DNZ yetersizse sessizce USDT komisyonuna düşer', () => {
    const q = quoteSpotFee(1000, { payWithDnz: true, dnzBalance: 0.1, dnzPrice: 0.5 })
    expect(q.useDnz).toBe(false)
    expect(q.usdtCharge).toBeCloseTo(1)
  })

  it('fiyat yoksa DNZ yolunu kapatır', () => {
    const q = quoteSpotFee(1000, { payWithDnz: true, dnzBalance: 100, dnzPrice: 0 })
    expect(q.useDnz).toBe(false)
    expect(q.usdtCharge).toBeCloseTo(1)
  })

  it('geçersiz tutarları sıfırlar', () => {
    const q = quoteSpotFee(-5, { payWithDnz: false, dnzBalance: 0, dnzPrice: 0.5 })
    expect(q.feeUsdt).toBe(0)
    expect(q.usdtCharge).toBe(0)
  })

  it('roundFee float artıklarını temizler', () => {
    expect(roundFee(0.1 + 0.2)).toBeCloseTo(0.3)
  })
})
