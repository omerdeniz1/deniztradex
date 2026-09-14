/** Common aliases so free-text searches like "ether", "bitcoin" or "solana"
 * match the ticker (ETH, BTC, SOL) even when the user never types the symbol. */
const BASE_ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin'],
  ETH: ['ethereum', 'ether'],
  SOL: ['solana'],
  DOGE: ['dogecoin'],
  XRP: ['ripple'],
  ADA: ['cardano'],
  AVAX: ['avalanche'],
  LTC: ['litecoin'],
  DOT: ['polkadot'],
  LINK: ['chainlink'],
  UNI: ['uniswap'],
  SHIB: ['shiba', 'shibainu'],
  PEPE: ['pepecoin'],
  TRX: ['tron'],
  MATIC: ['polygon'],
  NEAR: ['nearprotocol'],
  ATOM: ['cosmos'],
  FIL: ['filecoin'],
  BNB: ['bnb'],
  USDT: ['tether', 'usdt'],
}

export function baseOf(symbol: string): string {
  return symbol.replace(/USDT$/i, '')
}

export function matchPairQuery(symbol: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const base = baseOf(symbol)
  const baseLower = base.toLowerCase()
  const symbolLower = symbol.toLowerCase()

  if (baseLower.includes(q) || symbolLower.includes(q)) return true

  const aliases = BASE_ALIASES[base.toUpperCase()] ?? []
  return aliases.some((alias) => alias.toLowerCase().includes(q))
}