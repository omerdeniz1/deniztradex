import { describe, it, expect } from 'vitest'
import {
  calculateLiquidationPrice,
  calculatePnl,
  calculateRoe,
  capQuantityByBalance,
  clampLeverage,
  isLiquidated,
  marginCallDistancePct,
  MARGIN_CALL_THRESHOLD_PCT,
  MARGIN_CALL_THROTTLE_MS,
  maxQuantityByBalance,
  positionSize,
  requiredMargin,
  type OrderInput,
} from '@/engine/calculations'
import type { Position } from '@/types'

const basePosition = (overrides: Partial<Position> = {}): Position => ({
  id: 'pos_1',
  symbol: 'BTCUSDT',
  side: 'long',
  entryPrice: 100,
  quantity: 1,
  leverage: 10,
  mode: 'futures',
  openedAt: 1,
  ...overrides,
})

describe('calculatePnl', () => {
  it('computes positive PnL for a long when price rises', () => {
    const p = basePosition()
    expect(calculatePnl(p, 110)).toBeCloseTo(10)
  })

  it('computes negative PnL for a long when price falls', () => {
    const p = basePosition()
    expect(calculatePnl(p, 90)).toBeCloseTo(-10)
  })

  it('computes positive PnL for a short when price falls', () => {
    const p = basePosition({ side: 'short' })
    expect(calculatePnl(p, 90)).toBeCloseTo(10)
  })

  it('computes PnL scaled by quantity', () => {
    const p = basePosition({ quantity: 2.5 })
    expect(calculatePnl(p, 120)).toBeCloseTo(50)
  })
})

describe('calculateRoe', () => {
  it('returns 100% ROE when PnL equals the margin (10x)', () => {
    const p = basePosition()
    const margin = 100 * 1 / 10
    expect(margin).toBeCloseTo(10)
    expect(calculateRoe(p, 110)).toBeCloseTo(100)
  })

  it('returns approx -100% for a short hitting high leverage losses', () => {
    const p = basePosition({ side: 'short', leverage: 2 })
    // entry 100, qty 1, lev 2 -> margin 50; price 125 -> pnl -25 -> roe -50%
    expect(calculateRoe(p, 125)).toBeCloseTo(-50)
  })

  it('returns 0 for zero-quantity positions', () => {
    const p = basePosition({ quantity: 0 })
    expect(calculateRoe(p, 150)).toBe(0)
  })
})

describe('calculateLiquidationPrice', () => {
  it('long liquidation sits below entry price', () => {
    const liq = calculateLiquidationPrice(100, 10, 'long')
    expect(liq).toBeLessThan(100)
    expect(liq).toBeGreaterThan(80)
  })

  it('short liquidation sits above entry price', () => {
    const liq = calculateLiquidationPrice(100, 10, 'short')
    expect(liq).toBeGreaterThan(100)
    expect(liq).toBeLessThan(112)
  })

  it('higher leverage pushes long liquidation closer to price', () => {
    const liqLow = calculateLiquidationPrice(100, 5, 'long')
    const liqHigh = calculateLiquidationPrice(100, 50, 'long')
    expect(liqHigh).toBeGreaterThan(liqLow)
  })

  it('never returns negative for long', () => {
    const liq = calculateLiquidationPrice(1, 125, 'long')
    expect(liq).toBeGreaterThanOrEqual(0)
  })
})

describe('clampLeverage', () => {
  it('clamps below minimum to 1x', () => {
    expect(clampLeverage(0)).toBe(1)
    expect(clampLeverage(-4)).toBe(1)
  })

  it('clamps above maximum to 125x', () => {
    expect(clampLeverage(300)).toBe(125)
  })

  it('passes through valid values', () => {
    expect(clampLeverage(25)).toBe(25)
  })
})

describe('requiredMargin / maxQuantityByBalance / capQuantityByBalance', () => {
  it('computes margin as notional / leverage', () => {
    expect(requiredMargin(10000, 10)).toBeCloseTo(1000)
    expect(requiredMargin(10000, 5)).toBeCloseTo(2000)
  })

  it('returns zero margin for non-positive notional', () => {
    expect(requiredMargin(0, 10)).toBe(0)
  })

  it('max quantity scales with leverage', () => {
    expect(maxQuantityByBalance(100, 50, 1)).toBeCloseTo(2)
    expect(maxQuantityByBalance(100, 50, 10)).toBeCloseTo(20)
  })

  it('caps quantity to the affordable maximum', () => {
    expect(capQuantityByBalance(10, 100, 50, 2)).toBeCloseTo(4)
    expect(capQuantityByBalance(2, 100, 50, 2)).toBeCloseTo(2)
  })
})

describe('isLiquidated', () => {
  it('liquidates a long at/below liquidation price', () => {
    const p = basePosition({ side: 'long', entryPrice: 100, leverage: 10 })
    expect(isLiquidated(p, 88)).toBe(true)
    expect(isLiquidated(p, 100)).toBe(false)
  })

  it('liquidates a short at/above liquidation price', () => {
    const p = basePosition({ side: 'short', entryPrice: 100, leverage: 10 })
    expect(isLiquidated(p, 113)).toBe(true)
    expect(isLiquidated(p, 110)).toBe(false)
  })
})

describe('marginCallDistancePct', () => {
  it('returns a wide safety margin when the price sits at entry', () => {
    const p = basePosition({ side: 'long', entryPrice: 100, leverage: 10 })
    expect(marginCallDistancePct(p, 100)).toBeGreaterThan(MARGIN_CALL_THRESHOLD_PCT)
  })

  it('drops below the 5% threshold as a long nears liquidation', () => {
    const p = basePosition({ side: 'long', entryPrice: 100, leverage: 10 })
    const liq = calculateLiquidationPrice(100, 10, 'long')
    const near = liq * 1.02
    const distance = marginCallDistancePct(p, near)
    expect(distance).toBeGreaterThan(0)
    expect(distance).toBeLessThan(MARGIN_CALL_THRESHOLD_PCT)
  })

  it('shrinks toward zero for a short approaching its upper liquidation', () => {
    const p = basePosition({ side: 'short', entryPrice: 100, leverage: 10 })
    const liq = calculateLiquidationPrice(100, 10, 'short')
    const distanceNear = marginCallDistancePct(p, liq * 0.98)
    const distanceFar = marginCallDistancePct(p, 100)
    expect(distanceNear).toBeLessThan(distanceFar)
    expect(distanceNear).toBeLessThan(MARGIN_CALL_THRESHOLD_PCT)
  })

  it('exposes a 5% default threshold and a 30s throttle window', () => {
    expect(MARGIN_CALL_THRESHOLD_PCT).toBe(5)
    expect(MARGIN_CALL_THROTTLE_MS).toBe(30_000)
  })
})

describe('positionSize', () => {
  const order = (o: Partial<OrderInput>): OrderInput => ({
    symbol: 'BTCUSDT',
    side: 'long',
    mode: 'futures',
    quantity: 1,
    entryPrice: 10000,
    leverage: 10,
    ...o,
  })

  it('computes margin and fee for a valid futures order', () => {
    const size = positionSize(1000, order({}))
    expect(size.notional).toBeCloseTo(10000)
    expect(size.margin).toBeCloseTo(1000)
    expect(size.fee).toBeCloseTo(10)
  })

  it('rejects orders exceeding account purchasing power', () => {
    const size = positionSize(500, order({}))
    expect(size.quantity).toBe(0)
    expect(size.notional).toBe(0)
  })

  it('spot mode requires full notional as margin', () => {
    const size = positionSize(20000, order({ mode: 'spot', leverage: 10 }))
    expect(size.margin).toBeCloseTo(10000)
  })

  it('zero-quantity orders produce zero size', () => {
    const size = positionSize(100000, order({ quantity: 0 }))
    expect(size.quantity).toBe(0)
  })
})