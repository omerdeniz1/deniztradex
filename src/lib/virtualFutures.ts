import { MAX_LEVERAGE, MIN_LEVERAGE } from '@/engine/calculations'

/**
 * Sanal coin vadeli kontratları (perpetual, USDT marjinli).
 *
 * Kendi AMM havuzumuzdaki coinler (DNZ dahil) `/futures` ekranında long/short
 * açılabilir. Fiyat kaynağı havuzdur (sanal ticker → livePrices → mark-price);
 * likidasyon, TP/SL ve bekleyen emir watchdog'ları gerçek kontratlarla
 * BİREBİR aynı motoru kullanır.
 *
 * Risk freni: sanal havuzlar botlarla oynadığı için maksimum kaldıraç
 * gerçek coinlerin altındadır (20x). Motor (`tradeStore`) ve panel
 * (TradingPanel) bu tavanı ayrı ayrı uygular.
 *
 * NOT: sembol listesi `VIRTUAL_SEED` ile birebir tutulmalıdır (statik kopya —
 * `virtualMarketService` → `tradeStore` döngüsel import'unu önlemek için).
 * `virtualFutures.test.ts` eşleşmeyi kilitler.
 */

/** Sanal vadeli kontrat tavanı. */
export const VIRTUAL_MAX_LEVERAGE = 20

/** Sanal kontrat sembolleri (USDT soneksiz, büyük harf). */
export const VIRTUAL_FUTURES_SYMBOLS: ReadonlySet<string> = new Set([
  'DNZ',
  'ENTES',
  'V-XAU',
  'V-XAG',
  'RGC',
  'MPRC',
  'SVGC',
])

export function isVirtualFuturesSymbol(symbol: string): boolean {
  return VIRTUAL_FUTURES_SYMBOLS.has(symbol.trim().toUpperCase())
}

/** Sembole göre azami kaldıraç (sanal 20x, gerçek 125x). */
export function maxLeverageFor(symbol: string): number {
  return isVirtualFuturesSymbol(symbol) ? VIRTUAL_MAX_LEVERAGE : MAX_LEVERAGE
}

/** Vadeli kaldıracı sembole göre tavana çeker (spot etkilenmez). */
export function clampFuturesLeverage(symbol: string, leverage: number): number {
  if (!Number.isFinite(leverage) || leverage <= 0) return MIN_LEVERAGE
  return Math.min(Math.max(Math.floor(leverage), MIN_LEVERAGE), maxLeverageFor(symbol))
}
