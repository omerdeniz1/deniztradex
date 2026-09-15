import { describe, expect, it } from 'vitest'
import { boll, ema, lastDefined, sma } from '@/lib/indicators'

describe('sma', () => {
  it('averages the trailing window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('returns all null when data is shorter than the period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null])
  })
})

describe('ema', () => {
  it('seeds with SMA and smooths forward', () => {
    // period=3, k=0.5: seed=(1+2+3)/3=2, e4=4*0.5+2*0.5=3, e5=5*0.5+3*0.5=4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('returns all null when data is shorter than the period', () => {
    expect(ema([1, 2], 5)).toEqual([null, null])
  })
})

describe('boll', () => {
  it('computes basis and symmetric bands', () => {
    const { basis, upper, lower } = boll([10, 10, 10, 10, 10], 5)
    expect(basis[4]).toBeCloseTo(10)
    expect(upper[4]).toBeCloseTo(10)
    expect(lower[4]).toBeCloseTo(10)
  })

  it('widens bands with volatility', () => {
    const { basis, upper, lower } = boll([10, 12, 8, 12, 8], 5)
    expect(basis[4]).toBeCloseTo(10)
    expect(upper[4]).toBeGreaterThan(10)
    expect(lower[4]).toBeLessThan(10)
    expect(upper[4]! - 10).toBeCloseTo(10 - lower[4]!)
  })
})

describe('lastDefined', () => {
  it('returns the last non-null value', () => {
    expect(lastDefined([null, 1, null, 2.5, null])).toBe(2.5)
    expect(lastDefined([null, null])).toBeNull()
  })
})
