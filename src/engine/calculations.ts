import type { OrderSide, OrderType, Position, Ticker, TriggerType, TIF } from '@/types'

export const MIN_LEVERAGE = 1
export const MAX_LEVERAGE = 125

/**
 * Bakım marjini oranı (Binance Futures en düşük kademesi: %0.4).
 * Likidasyon, teminatın tamamı eridiğinde değil; bakım payı kadar
 * teminat kaldığında tetiklenir. DB'deki `risk_config` satırıyla
 * ayarlanabilir — buradaki değer çevrimdışı/test varsayılanıdır.
 */
export const MAINTENANCE_MARGIN_RATE = 0.004

/** Teminatın bu kadarlık kısmı eriyince İZLE uyarısı (kademeli uyarı 1/2). */
export const MARGIN_CALL_WARN_LOSS_FRAC = 0.5

/** Teminatın bu kadarlık kısmı eriyince KRİTİK margin-call + bayrak (2/2). */
export const MARGIN_CALL_CRITICAL_LOSS_FRAC = 0.8

/** Likidasyonun işletilmesi için gereken ardışık ihlal sayısı (fitil koruması). */
export const LIQ_CONFIRM_TICKS = 3

/** Mark-price medyan pencere genişliği (fitil koruması). */
export const MARK_PRICE_WINDOW = 5

/** Bot hamlesinin havuz rezervine oran üst sınırı (kayma koruması). */
export const BOT_MAX_POOL_FRACTION = 0.02

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
 * Liquidation price (USDT-margined USDT-perpetual style, isolated margin,
 * Binance Futures mantığı): pozisyon, teminat tamamen eridiğinde değil;
 * bakım marjini (`mmr`, varsayılan %0.4) kadar teminat kaldığında
 * likide olur. Yani liq fiyatı girişe `mmr` kadar daha yakındır — ama
 * karşılığında mark-price yumuşatma + ardışık-ihlal onayı + kademeli
 * uyarı ile tek fitiller patlatmaz (adil likidasyon).
 *
 * long:  entry * (1 - 1/leverage + mmr)
 * short: entry * (1 + 1/leverage - mmr)
 */
export function calculateLiquidationPrice(
  entryPrice: number,
  leverage: number,
  side: OrderSide,
  mmr: number = MAINTENANCE_MARGIN_RATE,
): number {
  const eff = clampLeverage(leverage)
  if (entryPrice <= 0) return 0
  const rate = Number.isFinite(mmr) && mmr >= 0 && mmr <= 0.1 ? mmr : MAINTENANCE_MARGIN_RATE
  const offset = 1 / eff

  if (side === 'long') {
    return Math.max(0, entryPrice * (1 - offset + rate))
  }
  return entryPrice * (1 + offset - rate)
}

/**
 * Tüketilen teminat oranı: -pnl / margin (0 = başabaş, 1 = teminat bitti,
 * >1 = likidasyon bölgesi). Kademeli uyarı merdiveni bununla çalışır.
 */
export function marginLossFraction(position: Position, currentPrice: number): number {
  const entryNotional = position.entryPrice * position.quantity
  if (entryNotional <= 0) return 0
  const margin = entryNotional / clampLeverage(position.leverage)
  if (margin <= 0) return 0
  return -calculatePnl(position, currentPrice) / margin
}

/** Kademeli risk seviyesi: safe → watch → margin-call → liquidating. */
export type RiskLevel = 'safe' | 'watch' | 'margin-call' | 'liquidating'

export function getRiskLevel(
  position: Position,
  currentPrice: number,
  warnFrac: number = MARGIN_CALL_WARN_LOSS_FRAC,
  criticalFrac: number = MARGIN_CALL_CRITICAL_LOSS_FRAC,
  mmr: number = MAINTENANCE_MARGIN_RATE,
): RiskLevel {
  if (isLiquidated(position, currentPrice, mmr)) return 'liquidating'
  const loss = marginLossFraction(position, currentPrice)
  if (loss >= criticalFrac) return 'margin-call'
  if (loss >= warnFrac) return 'watch'
  return 'safe'
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

export function isLiquidated(
  position: Position,
  currentPrice: number,
  mmr: number = MAINTENANCE_MARGIN_RATE,
): boolean {
  const liq = calculateLiquidationPrice(
    position.entryPrice,
    position.leverage,
    position.side,
    mmr,
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
    lossFraction: marginLossFraction(position, currentPrice),
    riskLevel: getRiskLevel(position, currentPrice),
  }
}