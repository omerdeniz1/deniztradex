import { describe, expect, it } from 'vitest'
import {
  advanceDnzPrice,
  dnzDayChange,
  DNZ_GENESIS_TS,
  DNZ_MAX_PRICE,
  DNZ_MAX_STEP_PCT,
  DNZ_MIN_PRICE,
  DNZ_PRICE_STEP_MS,
  DNZ_SEED_PRICE,
  dnzStepForTs,
  dnzStepHash,
  getDnzKlines,
} from '@/services/dnzService'

describe('dnzStepHash', () => {
  it('deterministiktir ve [0,1) aralığındadır', () => {
    expect(dnzStepHash(42)).toBe(dnzStepHash(42))
    expect(dnzStepHash(42)).toBeGreaterThanOrEqual(0)
    expect(dnzStepHash(42)).toBeLessThan(1)
    expect(dnzStepHash(43)).not.toBe(dnzStepHash(42))
  })
})

describe('dnzStepForTs', () => {
  it('genesis öncesi 0 döner, adımları 5 dakikada sayar', () => {
    expect(dnzStepForTs(DNZ_GENESIS_TS - 1)).toBe(0)
    expect(dnzStepForTs(DNZ_GENESIS_TS)).toBe(0)
    expect(dnzStepForTs(DNZ_GENESIS_TS + DNZ_PRICE_STEP_MS)).toBe(1)
    expect(dnzStepForTs(DNZ_GENESIS_TS + 12 * DNZ_PRICE_STEP_MS + 1000)).toBe(12)
  })
})

describe('advanceDnzPrice', () => {
  it('aynı adım aralığı her zaman aynı fiyatı üretir', () => {
    const a = advanceDnzPrice(DNZ_SEED_PRICE, 0, 100)
    const b = advanceDnzPrice(DNZ_SEED_PRICE, 0, 100)
    expect(a.price).toBe(b.price)
    expect(a.step).toBe(100)
  })

  it('kademeli ilerletme tek seferle aynı sonucu verir', () => {
    const whole = advanceDnzPrice(DNZ_SEED_PRICE, 0, 50)
    const first = advanceDnzPrice(DNZ_SEED_PRICE, 0, 20)
    const rest = advanceDnzPrice(first.price, first.step, 50)
    expect(rest.price).toBe(whole.price)
  })

  it('adım başına gürültü ±%1.5 ile sınırlıdır (tohum fiyattan)', () => {
    const { price } = advanceDnzPrice(DNZ_SEED_PRICE, 0, 1)
    expect(price).toBeGreaterThanOrEqual(DNZ_SEED_PRICE * (1 - DNZ_MAX_STEP_PCT) - 1e-12)
    expect(price).toBeLessThanOrEqual(DNZ_SEED_PRICE * (1 + DNZ_MAX_STEP_PCT) + 1e-12)
  })

  it('uzun vadede tohum çevresinde bantta kalır (tavan/tabana yapışmaz)', () => {
    const { price } = advanceDnzPrice(DNZ_SEED_PRICE, 0, 100000)
    expect(price).toBeGreaterThan(DNZ_MIN_PRICE * 2)
    expect(price).toBeLessThan(DNZ_MAX_PRICE / 2)
  })

  it('fiyat taban/tavan aralığında kalır', () => {
    const low = advanceDnzPrice(0.000001, 0, 5000)
    expect(low.price).toBeGreaterThanOrEqual(DNZ_MIN_PRICE)
    const high = advanceDnzPrice(1e9, 0, 5000)
    expect(high.price).toBeLessThanOrEqual(DNZ_MAX_PRICE)
  })

  it('geri adıma ilerlemez', () => {
    const r = advanceDnzPrice(0.5, 10, 5)
    expect(r.step).toBe(10)
    expect(r.price).toBeCloseTo(0.5)
  })
})

describe('getDnzKlines', () => {
  const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)

  it('aynı girdide aynı mumları üretir (deterministik)', () => {
    const a = getDnzKlines('1h', NOW, 50)
    const b = getDnzKlines('1h', NOW, 50)
    expect(a).toEqual(b)
    expect(a).toHaveLength(50)
  })

  it('mumlar sıralı, hizalı ve OHLC tutarlıdır', () => {
    const klines = getDnzKlines('15m', NOW, 100)
    const ms = 15 * 60 * 1000
    klines.forEach((k, i) => {
      expect(k.openTime % ms).toBe(0)
      if (i > 0) expect(k.openTime).toBeGreaterThan(klines[i - 1]?.openTime ?? 0)
      expect(k.high).toBeGreaterThanOrEqual(Math.max(k.open, k.close))
      expect(k.low).toBeLessThanOrEqual(Math.min(k.open, k.close))
      expect(k.volume).toBeGreaterThan(0)
      // Tamamlanan mumlar tam kova boyundadır; oluşamamış son mum kısadır.
      if (i < klines.length - 1) expect(k.closeTime).toBe(k.openTime + ms - 1)
      else expect(k.closeTime).toBeLessThanOrEqual(k.openTime + ms - 1)
    })
  })

  it('oluşan mumun kapanışı canlı fiyatla aynı kaynaktan gelir', () => {
    const step = dnzStepForTs(NOW)
    const tick = advanceDnzPrice(DNZ_SEED_PRICE, 0, step)
    const klines = getDnzKlines('5m', NOW, 10)
    const last = klines[klines.length - 1]
    expect(last).toBeDefined()
    expect(last?.close).toBe(tick.price)
  })

  it('geçersiz girdide boş döner', () => {
    expect(getDnzKlines('1h', DNZ_GENESIS_TS - 1, 10)).toEqual([])
    expect(getDnzKlines('1h', NOW, 0)).toEqual([])
  })
})

describe('dnzDayChange', () => {
  it('sonlu değişim yüzdeleri üretir', () => {
    const { change, changePct } = dnzDayChange(Date.UTC(2026, 5, 15, 12, 0, 0))
    expect(Number.isFinite(change)).toBe(true)
    expect(Number.isFinite(changePct)).toBe(true)
  })
})
