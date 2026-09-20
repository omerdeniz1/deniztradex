import { describe, expect, it } from 'vitest'
import {
  advanceDnzPrice,
  DNZ_GENESIS_TS,
  DNZ_MAX_PRICE,
  DNZ_MAX_STEP_PCT,
  DNZ_MIN_PRICE,
  DNZ_PRICE_STEP_MS,
  DNZ_SEED_PRICE,
  dnzStepForTs,
  dnzStepHash,
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
