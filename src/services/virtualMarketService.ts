import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUserId } from '@/services/authService'
import { useTradeStore } from '@/store/tradeStore'
import { quoteVirtualBuy, quoteVirtualSell, type VirtualQuote } from '@/engine/virtualAmm'
import type { Interval, Kline } from '@/types'

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

const INTERVAL_MINUTES: Record<Interval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
}

/** 1 dakikalık mumları üst zaman dilimine katla (eski → yeni sıralı). */
export function bucketVirtualKlines(klines1m: Kline[], interval: Interval): Kline[] {
  const size = INTERVAL_MINUTES[interval] ?? 1
  if (size <= 1) return klines1m
  const out: Kline[] = []
  for (let i = 0; i < klines1m.length; i += size) {
    const chunk = klines1m.slice(i, i + size)
    if (chunk.length === 0) continue
    const first = chunk[0]
    const last = chunk[chunk.length - 1]
    out.push({
      openTime: first.openTime,
      open: first.open,
      high: Math.max(...chunk.map((k) => k.high)),
      low: Math.min(...chunk.map((k) => k.low)),
      close: last.close,
      volume: chunk.reduce((s, k) => s + k.volume, 0),
      closeTime: last.closeTime,
    })
  }
  return out
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Yerel sentetik mumlar (çevrimdışı): havuz fiyatına biten, sembolden
 * türetilen deterministik yürüyüş — grafik her ortamda çizilir.
 */
function syntheticKlines(symbol: string, price: number, limit: number): Kline[] {
  const rand = mulberry32(hashSeed(symbol))
  const out: Kline[] = []
  const nowMin = Math.floor(Date.now() / 60000) * 60000
  let p = price <= 0 ? 1 : price / (1 + (rand() - 0.5) * 0.02 * limit)
  for (let i = limit - 1; i >= 0; i--) {
    const t = nowMin - i * 60000
    const o = p
    const c = o * (1 + (rand() - 0.5) * 0.004)
    const h = Math.max(o, c) * (1 + rand() * 0.001)
    const l = Math.min(o, c) * (1 - rand() * 0.001)
    out.push({ openTime: t, open: o, high: h, low: l, close: c, volume: price * (0.5 + rand()), closeTime: t + 59999 })
    p = c
  }
  // Son mumu güncel havuz fiyatına kilitle (grafik ↔ liste tutarlılığı).
  if (out.length > 0 && price > 0) {
    const last = out[out.length - 1]
    out[out.length - 1] = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
  }
  return out
}

/**
 * Sanal mumlar: gerçekte `virtual_kline_data` tablosundan (yeniden eskiye
 * değil, eskiye-yeniye bucket'lanır); çevrimdışında sentetik üretilir.
 */
export async function listVirtualKlines(
  symbol: string,
  interval: Interval = '1m',
  limit = 300,
): Promise<Kline[]> {
  const size = INTERVAL_MINUTES[interval] ?? 1
  const need1m = Math.min(limit * size, 1500)
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('virtual_kline_data')
        .select('timestamp,open,high,low,close,volume')
        .eq('symbol', symbol)
        .order('timestamp', { ascending: false })
        .limit(need1m)
      if (!error && Array.isArray(data) && data.length > 0) {
        const asc = (data as Record<string, unknown>[]).reverse().map((r) => {
          const t = Date.parse(String(r.timestamp ?? ''))
          return {
            openTime: Number.isFinite(t) ? t : 0,
            open: toNumber(r.open),
            high: toNumber(r.high),
            low: toNumber(r.low),
            close: toNumber(r.close),
            volume: toNumber(r.volume),
            closeTime: (Number.isFinite(t) ? t : 0) + 59999,
          }
        })
        return bucketVirtualKlines(asc, interval).slice(-limit)
      }
    } catch {
      // sentetik döküme düş
    }
  }
  const coins = await listVirtualCoins()
  const price = coins.find((c) => c.symbol === symbol)?.price ?? 0
  return bucketVirtualKlines(syntheticKlines(symbol, price, need1m), interval).slice(-limit)
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
