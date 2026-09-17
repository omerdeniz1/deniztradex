import { MARK_PRICE_WINDOW } from '@/engine/calculations'

/**
 * Mark-price beslemesi (Binance Futures mantığı): likidasyon ve margin-call
 * kararları HAM son tik ile değil; son N tikin MEDYANI'dan üretilen
 * "mark" fiyatla verilir. Tek tiklik fitiller (AMM bot spike'ı, borsa
 * iğnesi) medyanı oynatamaz — pozisyon patlatmaz.
 *
 * Pencere varsayılanı MARK_PRICE_WINDOW (5); DB `risk_config` ile
 * ayarlanabilir (useRiskParams → setMarkPriceWindow).
 */

let windowSize = MARK_PRICE_WINDOW
const buffers = new Map<string, number[]>()

/** Test edilebilirlik + sembol değişiminde tazelik için pencere ayarı. */
export function setMarkPriceWindow(n: number): void {
  if (Number.isFinite(n) && n >= 1 && n <= 50) windowSize = Math.floor(n)
}

export function resetMarkPrices(symbol?: string): void {
  if (symbol) buffers.delete(symbol.toUpperCase())
  else buffers.clear()
}

function keyOf(symbol: string): string {
  return symbol.trim().toUpperCase()
}

/** Yeni tiki işle ve güncel mark fiyatı döndür. */
export function pushMarkPrice(symbol: string, price: number): number {
  const key = keyOf(symbol)
  if (!Number.isFinite(price) || price <= 0) {
    return getMarkPrice(symbol, 0)
  }
  const buf = buffers.get(key) ?? []
  buf.push(price)
  while (buf.length > windowSize) buf.shift()
  buffers.set(key, buf)
  return medianOf(buf)
}

/** Tiki işlemeden mevcut mark fiyatı oku (yoksa fallback). */
export function getMarkPrice(symbol: string, fallback = 0): number {
  const buf = buffers.get(keyOf(symbol))
  if (!buf || buf.length === 0) return fallback
  return medianOf(buf)
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}
