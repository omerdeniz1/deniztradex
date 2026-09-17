import { beforeEach, describe, expect, it } from 'vitest'
import {
  getMarkPrice,
  pushMarkPrice,
  resetMarkPrices,
  setMarkPriceWindow,
} from '@/engine/markPrice'

beforeEach(() => {
  resetMarkPrices()
  setMarkPriceWindow(5)
})

describe('markPrice (fitil koruması)', () => {
  it('tek tikte son fiyatı döndürür', () => {
    expect(pushMarkPrice('BTCUSDT', 100)).toBe(100)
  })

  it('tek fitili medyanla yutar', () => {
    pushMarkPrice('BTCUSDT', 100)
    pushMarkPrice('BTCUSDT', 101)
    pushMarkPrice('BTCUSDT', 99)
    pushMarkPrice('BTCUSDT', 100)
    const mark = pushMarkPrice('BTCUSDT', 150)
    // medyan(99,100,100,101,150) = 100 — 150'lik iğne patlatmaz
    expect(mark).toBe(100)
  })

  it('kalıcı hareketi pencere dolunca takip eder', () => {
    for (let i = 0; i < 5; i++) pushMarkPrice('ETHUSDT', 100)
    for (let i = 0; i < 5; i++) pushMarkPrice('ETHUSDT', 120)
    expect(getMarkPrice('ETHUSDT', 0)).toBe(120)
  })

  it('bilinmeyen sembolde fallback döndürür', () => {
    expect(getMarkPrice('YOKUSDT', 42)).toBe(42)
  })

  it('geçersiz fiyatı yok sayar', () => {
    pushMarkPrice('BTCUSDT', 100)
    expect(pushMarkPrice('BTCUSDT', NaN)).toBe(100)
  })
})
