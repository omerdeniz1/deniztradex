/**
 * Symbols whose per-pair market data could not be loaded (e.g. delisted or
 * suspended pairs). Binance keeps serving 24h tickers for some non-tradeable
 * pairs, so a failed klines fetch is the reliable signal that a pair is gone.
 */
const delistedSymbols = new Set<string>()

export function markDelisted(symbol: string): void {
  delistedSymbols.add(symbol.toUpperCase())
}

export function isDelisted(symbol: string): boolean {
  return delistedSymbols.has(symbol.toUpperCase())
}