import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUserId } from '@/services/authService'
import { useTradeStore } from '@/store/tradeStore'
import { quoteVirtualBuy, quoteVirtualSell, type VirtualQuote } from '@/engine/virtualAmm'

/**
 * Sanal Piyasa servisi (AMM x*y=k).
 *
 * - Supabase yapılandırılmışsa: `virtual_coins` tablosu + holdings +
 *   `execute_virtual_trade` RPC'si (gerçek havuz, tüm cihazlarda ortak).
 * - Değilse (vitest / çevrimdışı / yerel e2e): AYNI matematikle çalışan
 *   yerel motor (tohum verisi + localStorage kalıcılığı). Böylece
 *   Piyasalar → Sanal Piyasa her ortamda canlıdır ve test edilebilir.
 */

export type VirtualCoinType = 'crypto' | 'commodity'
export type VirtualTradeSide = 'buy' | 'sell'

export interface VirtualCoin {
  symbol: string
  name: string
  type: VirtualCoinType
  reserveUsdt: number
  reserveToken: number
  price: number
  volume24h: number
}

export interface VirtualTradeResult {
  tokenAmount: number
  usdtAmount: number
  price: number
  newPrice: number
  priceImpactPct: number
}

interface VirtualSeed {
  symbol: string
  name: string
  type: VirtualCoinType
  reserveUsdt: number
  reserveToken: number
  price: number
}

export const VIRTUAL_SEED: VirtualSeed[] = [
  { symbol: 'ENTES', name: 'ENTES COIN', type: 'crypto', reserveUsdt: 50000000, reserveToken: 5000000, price: 10 },
  { symbol: 'V-XAU', name: 'Sanal Altın', type: 'commodity', reserveUsdt: 30000000, reserveToken: 300000, price: 100 },
  { symbol: 'V-XAG', name: 'Sanal Gümüş', type: 'commodity', reserveUsdt: 20000000, reserveToken: 1000000, price: 20 },
  { symbol: 'RGC', name: 'RGCOIN', type: 'crypto', reserveUsdt: 1000000, reserveToken: 100000000, price: 0.01 },
  { symbol: 'MPRC', name: 'MPRCOIN', type: 'crypto', reserveUsdt: 800000, reserveToken: 26666666, price: 0.03 },
  { symbol: 'SVGC', name: 'SVGCOIN', type: 'crypto', reserveUsdt: 500000, reserveToken: 100000000, price: 0.005 },
]

const POOLS_KEY = 'deniztradx_virtual_pools'
const HOLDINGS_KEY = 'deniztradx_virtual_holdings'

interface LocalPool {
  reserveUsdt: number
  reserveToken: number
  volume24h: number
}

function readPools(): Record<string, LocalPool> {
  try {
    const raw = localStorage.getItem(POOLS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, LocalPool>
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {
    // yoksay — tohumdan başla
  }
  const out: Record<string, LocalPool> = {}
  for (const s of VIRTUAL_SEED) {
    out[s.symbol] = { reserveUsdt: s.reserveUsdt, reserveToken: s.reserveToken, volume24h: 0 }
  }
  return out
}

function writePools(pools: Record<string, LocalPool>): void {
  try {
    localStorage.setItem(POOLS_KEY, JSON.stringify(pools))
  } catch {
    // kota/gizli mod — yalnızca bellekte yaşar
  }
}

function readLocalHoldings(): Record<string, number> {
  try {
    const raw = localStorage.getItem(HOLDINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, number> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
        }
        return out
      }
    }
  } catch {
    // yoksay
  }
  return {}
}

function writeLocalHoldings(holdings: Record<string, number>): void {
  try {
    localStorage.setItem(HOLDINGS_KEY, JSON.stringify(holdings))
  } catch {
    // yoksay
  }
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? (n as number) : 0
}

/** Piyasa listesi: önce Supabase, yoksa yerel motor. */
export async function listVirtualCoins(): Promise<VirtualCoin[]> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('virtual_coins')
        .select('symbol,name,type,reserve_usdt,reserve_token,current_price,volume_24h')
        .order('symbol')
      if (!error && Array.isArray(data) && data.length > 0) {
        return (data as Record<string, unknown>[]).map((r) => ({
          symbol: String(r.symbol ?? ''),
          name: String(r.name ?? ''),
          type: r.type === 'commodity' ? 'commodity' : 'crypto',
          reserveUsdt: toNumber(r.reserve_usdt),
          reserveToken: toNumber(r.reserve_token),
          price: toNumber(r.current_price),
          volume24h: toNumber(r.volume_24h),
        }))
      }
    } catch {
      // yerel motora düş
    }
  }
  const pools = readPools()
  return VIRTUAL_SEED.map((s) => {
    const p = pools[s.symbol]
    const reserveUsdt = p ? p.reserveUsdt : s.reserveUsdt
    const reserveToken = p ? p.reserveToken : s.reserveToken
    return {
      symbol: s.symbol,
      name: s.name,
      type: s.type,
      reserveUsdt,
      reserveToken,
      price: reserveToken > 0 ? reserveUsdt / reserveToken : s.price,
      volume24h: p ? p.volume24h : 0,
    }
  })
}

/** Kullanıcının sanal coin bakiyeleri (sembol → adet). */
export async function getVirtualHoldings(): Promise<Record<string, number>> {
  const userId = getSessionUserId()
  if (isSupabaseConfigured && supabase && userId) {
    try {
      const { data, error } = await supabase
        .from('virtual_holdings')
        .select('symbol,quantity')
        .eq('user_id', userId)
      if (!error && Array.isArray(data)) {
        const out: Record<string, number> = {}
        for (const r of data as Record<string, unknown>[]) {
          const q = toNumber(r.quantity)
          if (typeof r.symbol === 'string' && q > 0) out[r.symbol] = q
        }
        return out
      }
    } catch {
      // yerel döküme düş
    }
  }
  return readLocalHoldings()
}

function applyLocalTrade(
  symbol: string,
  side: VirtualTradeSide,
  amount: number,
  quote: VirtualQuote,
): VirtualTradeResult {
  const trade = useTradeStore.getState()
  const pools = readPools()
  const pool = pools[symbol]
  if (!pool) throw new Error('Coin bulunamadı.')

  if (side === 'buy') {
    if (trade.balance < amount) throw new Error('Yetersiz USDT bakiyesi.')
    trade.setBalance(Math.max(0, Math.round((trade.balance - amount) * 100) / 100))
    const holdings = readLocalHoldings()
    holdings[symbol] = (holdings[symbol] ?? 0) + quote.tokenAmount
    writeLocalHoldings(holdings)
  } else {
    const holdings = readLocalHoldings()
    if ((holdings[symbol] ?? 0) < amount) throw new Error('Yetersiz coin bakiyesi.')
    holdings[symbol] = holdings[symbol] - amount
    if (holdings[symbol] <= 0) delete holdings[symbol]
    writeLocalHoldings(holdings)
    trade.setBalance(Math.round((trade.balance + quote.usdtAmount) * 100) / 100)
  }

  pools[symbol] = {
    reserveUsdt: quote.newReserveUsdt,
    reserveToken: quote.newReserveToken,
    volume24h: pool.volume24h + quote.usdtAmount,
  }
  writePools(pools)

  return {
    tokenAmount: quote.tokenAmount,
    usdtAmount: quote.usdtAmount,
    price: quote.oldPrice,
    newPrice: quote.newPrice,
    priceImpactPct: quote.priceImpactPct,
  }
}

/**
 * AMM takası çalıştır.
 * - buy: amount = yatırılan USDT → token verir.
 * - sell: amount = satılan token adedi → USDT verir.
 */
export async function executeVirtualTrade(
  symbol: string,
  side: VirtualTradeSide,
  amount: number,
): Promise<VirtualTradeResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Geçersiz tutar.')
  }
  const userId = getSessionUserId()
  if (!userId) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('execute_virtual_trade', {
      p_user_id: userId,
      p_symbol: symbol,
      p_trade_type: side,
      p_amount: amount,
    })
    if (error) {
      throw new Error(mapRpcError(error))
    }
    const r = data as Record<string, unknown> | null
    if (!r || r.ok !== true) throw new Error('İşlem gerçekleştirilemedi.')
    return {
      tokenAmount: toNumber(r.token_amount),
      usdtAmount: toNumber(r.usdt_amount),
      price: toNumber(r.price),
      newPrice: toNumber(r.new_price),
      priceImpactPct: toNumber(r.price_impact_pct),
    }
  }

  // Yerel motor: aynı x*y=k matematiği.
  const pools = readPools()
  const pool = pools[symbol]
  if (!pool) throw new Error('Coin bulunamadı.')
  const quote =
    side === 'buy'
      ? quoteVirtualBuy(
          { symbol, reserveUsdt: pool.reserveUsdt, reserveToken: pool.reserveToken },
          amount,
        )
      : quoteVirtualSell(
          { symbol, reserveUsdt: pool.reserveUsdt, reserveToken: pool.reserveToken },
          amount,
        )
  return applyLocalTrade(symbol, side, amount, quote)
}

function mapRpcError(error: unknown): string {
  const msg = String((error as { message?: unknown })?.message ?? '')
  if (msg.includes('yetersiz USDT')) return 'Yetersiz USDT bakiyesi.'
  if (msg.includes('yetersiz coin')) return 'Yetersiz coin bakiyesi.'
  if (msg.includes('bulunamadı')) return 'Coin bulunamadı.'
  if (msg.includes('yetkisiz')) return 'Bu işlem için yetkin yok.'
  if (msg.includes('derinliği')) return 'Havuz derinliği yetersiz.'
  if (msg.includes('tutarı') || msg.includes('tutar')) return 'Geçersiz tutar.'
  return msg || 'İşlem gerçekleştirilemedi.'
}
