import type { OrderSide, OrderType, Position, Ticker, TriggerType, TIF } from '@/types'

export const MIN_LEVERAGE = 1
export const MAX_LEVERAGE = 125

const LIQUIDATION_BUFFER = 0.005

/** Warn when the mark price gets within this % of the liquidation price. */
export const MARGIN_CALL_THRESHOLD_PCT = 5

/** Minimum delay between margin-call toasts for the same position (ms). */
export const MARGIN_CALL_THROTTLE_MS = 30_000

export interface OrderInput {
  symbol: string
  side: OrderSide
  mode: 'spot' | 'futures'
  quantity: number
  entryPrice: number
  leverage: number
  orderType?: OrderType
  stopPrice?: number
  tpPrice?: number | null
  slPrice?: number | null
  triggerType?: TriggerType
  reduceOnly?: boolean
  postOnly?: boolean
  tif?: TIF
  cbRate?: number
  marketPrice?: number
}

export interface PositionSize {
  quantity: number
  notional: number
  margin: number
  fee: number
}

export function clampLeverage(leverage: number): number {
  if (!Number.isFinite(leverage) || leverage <= 0) return MIN_LEVERAGE
  return Math.min(Math.max(leverage, MIN_LEVERAGE), MAX_LEVERAGE)
}

export function requiredMargin(notional: number, leverage: number): number {
  if (notional <= 0 || leverage <= 0) return 0
  return notional / clampLeverage(leverage)
}

export function maxQuantityByBalance(
  balance: number,
  price: number,
  leverage: number,
): number {
  if (price <= 0 || balance <= 0) return 0
  return (balance * clampLeverage(leverage)) / price
}

export function capQuantityByBalance(
  quantity: number,
  balance: number,
  price: number,
  leverage: number,
): number {
  if (quantity <= 0) return 0
  return Math.min(quantity, maxQuantityByBalance(balance, price, leverage))
}

/**
 * Snapshot PnL for a position at `currentPrice`.
 * futures: (current - entry) * quantity * direction
 * spot:    (current - entry) * quantity * direction (fee ignored for demo)
 */
export function calculatePnl(position: Position, currentPrice: number): number {
  const direction = position.side === 'long' ? 1 : -1
  return (currentPrice - position.entryPrice) * position.quantity * direction
}

export function calculateRoe(
  position: Position,
  currentPrice: number,
): number {
  const entryNotional = position.entryPrice * position.quantity
  if (entryNotional <= 0) return 0
  const margin = entryNotional / position.leverage
  if (margin <= 0) return 0
  const pnl = calculatePnl(position, currentPrice)
  return (pnl / margin) * 100
}

/**
 * Liquidation price approximation (USDT-margined USDT-perpetual style,
 * isolated margin, no maintenance margin buffering beyond a small tolerance).
 *
 * long:  entry * (1 - 1/leverage)   (approx)
 * short: entry * (1 + 1/leverage)
 */
export function calculateLiquidationPrice(
  entryPrice: number,
  leverage: number,
  side: OrderSide,
): number {
  const eff = clampLeverage(leverage)
  if (entryPrice <= 0) return 0
  const offset = 1 / eff

  if (side === 'long') {
    // Liquidation triggered slightly BEFORE margin is fully wiped.
    const liq = entryPrice * (1 - offset) * (1 - LIQUIDATION_BUFFER)
    return Math.max(0, liq)
  }
  return entryPrice * (1 + offset) * (1 + LIQUIDATION_BUFFER)
}

export function positionSize(balance: number, input: OrderInput): PositionSize {
  const price = input.entryPrice
  const lev = clampLeverage(input.leverage)
  const quantity = Math.max(0, input.quantity)

  const notional = price * quantity
  const margin = input.mode === 'futures' ? requiredMargin(notional, lev) : notional

  const usableNotional = balance * (input.mode === 'futures' ? lev : 1)
  if (notional > usableNotional) {
    return { quantity: 0, notional: 0, margin: 0, fee: 0 }
  }

  const fee = notional * 0.001
  return { quantity, notional, margin, fee }
}

export function isLiquidated(position: Position, currentPrice: number): boolean {
  const liq = calculateLiquidationPrice(
    position.entryPrice,
    position.leverage,
    position.side,
  )
  if (position.side === 'long') {
    return currentPrice <= liq
  }
  return currentPrice >= liq
}

/**
 * Distance (in %) between the current mark price and the liquidation price.
 * Always positive while there is margin room left; a long's price falling
 * toward its (lower) liq price shrinks it, a short's price rising toward its
 * (higher) liq price shrinks it.
 */
export function marginCallDistancePct(position: Position, currentPrice: number): number {
  const liq = calculateLiquidationPrice(position.entryPrice, position.leverage, position.side)
  if (currentPrice <= 0) return Number.POSITIVE_INFINITY
  const rawGap = position.side === 'long' ? currentPrice - liq : liq - currentPrice
  return (rawGap / currentPrice) * 100
}

export function getPositionSnapshot(
  position: Position,
  ticker: Ticker | null,
) {
  const currentPrice = ticker?.symbol === position.symbol && ticker.price > 0
    ? ticker.price
    : position.entryPrice
  const pnl = calculatePnl(position, currentPrice)
  const roe = calculateRoe(position, currentPrice)
  const liquidationPrice = calculateLiquidationPrice(
    position.entryPrice,
    position.leverage,
    position.side,
  )
  return {
    ...position,
    currentPrice,
    pnl,
    roe,
    liquidationPrice,
    isLiquidated: isLiquidated(position, currentPrice),
  }
}