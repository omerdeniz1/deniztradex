import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUserId } from '@/services/authService'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore } from '@/store/dnzStore'
import {
  quoteVirtualBuy,
  quoteVirtualSell,
  quoteVirtualSellForUsdt,
  type VirtualQuote,
} from '@/engine/virtualAmm'
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
  { symbol: 'DNZ', name: 'DNZ Token', type: 'crypto', reserveUsdt: 100000000, reserveToken: 200000000, price: 0.5 },
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
  let out: Record<string, LocalPool> = {}
  try {
    const raw = localStorage.getItem(POOLS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, LocalPool>
      if (parsed && typeof parsed === 'object') out = parsed
    }
  } catch {
    // yoksay — tohumdan başla
  }
  if (Object.keys(out).length === 0) {
    for (const s of VIRTUAL_SEED) {
      out[s.symbol] = { reserveUsdt: s.reserveUsdt, reserveToken: s.reserveToken, volume24h: 0 }
    }
    return out
  }
  // Tohumda olup depoda olmayan havuzlar (DNZ gibi sonradan eklenen
  // coinler) tohum değerleriyle birleşir — eski depoyu bozmaz.
  for (const s of VIRTUAL_SEED) {
    const p = out[s.symbol]
    if (!p || !Number.isFinite(p.reserveUsdt) || !Number.isFinite(p.reserveToken)) {
      out[s.symbol] = { reserveUsdt: s.reserveUsdt, reserveToken: s.reserveToken, volume24h: 0 }
    }
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

export interface VirtualChange {
  change: number
  changePct: number
}

/**
 * Sanal coinlerin 24 saatlik fiyat değişimi (Piyasalar'daki % sütunu için).
 *
 * Birincil kaynak `virtual_24h_changes` RPC'sidir: her sembole ayrı
 * bakılır (24s öncesi kapanış, yoksa en eski) — global `limit()` ile
 * çekip eşleştiren eski yöntem genç coinleri (DNZ) ıskalayıp %'yi
 * sürekli 0 gösteriyordu. RPC yoksa (eski DB) tablo sorgusuna,
 * çevrimdışında yerel sentetik mumlara düşülür (yerel grafikle tutarlı).
 */
export async function listVirtual24hChanges(): Promise<Record<string, VirtualChange>> {
  if (!isSupabaseConfigured || !supabase) return localVirtual24hChanges()
  try {
    const { data, error } = await supabase.rpc('virtual_24h_changes')
    if (!error && data && typeof data === 'object') {
      const out: Record<string, VirtualChange> = {}
      for (const [sym, v] of Object.entries(data as Record<string, unknown>)) {
        const row = v as { change?: unknown; change_pct?: unknown } | null
        const change = toNumber(row?.change)
        const changePct = toNumber(row?.change_pct)
        if (typeof sym === 'string' && sym) out[sym.toUpperCase()] = { change, changePct }
      }
      return out
    }
  } catch {
    // eski DB yedeğine düş
  }
  return legacyVirtual24hChanges()
}

/**
 * Yerel 24s değişimi: çevrimdışı grafikle AYNI sentetik mumlardan
 * (ilk → son kapanış). Havuz fiyatı hareket ettiyse % de oynar.
 */
async function localVirtual24hChanges(): Promise<Record<string, VirtualChange>> {
  try {
    const coins = await listVirtualCoins()
    const out: Record<string, VirtualChange> = {}
    for (const c of coins) {
      if (!(c.price > 0)) continue
      const klines = syntheticKlines(c.symbol, c.price, 1440)
      if (klines.length < 2) continue
      const first = klines[0]?.close ?? 0
      const last = klines[klines.length - 1]?.close ?? 0
      if (!(first > 0) || !(last > 0)) continue
      const change = last - first
      out[c.symbol.toUpperCase()] = { change, changePct: (change / first) * 100 }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Eski DB yedeği: tablo sorgulu hesaplama (RPC öncesi davranış).
 * Global limit körlüğü içerir — yalnızca RPC'siz DB'ler için.
 */
async function legacyVirtual24hChanges(): Promise<Record<string, VirtualChange>> {
  if (!supabase) return {}
  try {
    const [coins, refRows, earlyRows] = await Promise.all([
      listVirtualCoins(),
      supabase
        .from('virtual_kline_data')
        .select('symbol,close,timestamp')
        .lte('timestamp', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
        .order('timestamp', { ascending: false })
        .limit(300),
      supabase
        .from('virtual_kline_data')
        .select('symbol,close,timestamp')
        .order('timestamp', { ascending: true })
        .limit(300),
    ])
    const pickFirst = (
      rows: unknown,
    ): Map<string, number> => {
      const out = new Map<string, number>()
      if (!Array.isArray(rows)) return out
      for (const r of rows as Record<string, unknown>[]) {
        const sym = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : ''
        if (!sym || out.has(sym)) continue
        const close = toNumber(r.close)
        if (close > 0) out.set(sym, close)
      }
      return out
    }
    const ref = pickFirst(refRows.data)
    const early = pickFirst(earlyRows.data)
    const out: Record<string, VirtualChange> = {}
    for (const c of coins) {
      const key = c.symbol.toUpperCase()
      const base = ref.get(key) ?? early.get(key) ?? 0
      if (!(base > 0) || !(c.price > 0)) continue
      const change = c.price - base
      out[key] = { change, changePct: (change / base) * 100 }
    }
    return out
  } catch {
    return {}
  }
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
        // DNZ bakiyesi sanal defterde değil dnz defterindedir
        // (`dnz_balances`) — panel/cüzdan/transfer tek haritadan okusun
        // diye burada birleşir; yoksa DNZ satışta "0" görünür.
        try {
          const dnz = await supabase
            .from('dnz_balances')
            .select('balance')
            .eq('user_id', userId)
            .maybeSingle()
          const q = toNumber((dnz.data as { balance?: unknown } | null)?.balance)
          if (!dnz.error && q > 0) out['DNZ'] = q
        } catch {
          // yoksay — sanal liste aynen döner
        }
        return out
      }
    } catch {
      // yerel döküme düş
    }
  }
  const out = readLocalHoldings()
  // Yerelde DNZ, hesap bazlı dnz store'dadır (sanal defter cihaz-ortaktır).
  try {
    const dnzBal = useDnzStore.getState().balance
    if (dnzBal > 0) out['DNZ'] = dnzBal
  } catch {
    // yoksay
  }
  return out
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
 * DNZ takas yerleşimi (yerel motor): havuz x*y=k aynen işler, DNZ
 * bacağı `dnzStore` (bakiye + `fee_discount` dışı `buy`/`sell` defteri),
 * USDT bacağı `tradeStore` üzerinden — diğer sanal coinlerle aynı
 * davranış, tek fark DNZ `virtual_holdings`'te DEĞİL `dnz_balances`'ta
 * durur (komisyon indirimi + transfer + cüzdan aynen çalışır).
 */
function applyDnzTrade(
  side: VirtualTradeSide,
  amount: number,
  quote: VirtualQuote,
): VirtualTradeResult {
  const trade = useTradeStore.getState()
  const dnz = useDnzStore.getState()
  const pools = readPools()
  const pool = pools['DNZ']
  if (!pool) throw new Error('Coin bulunamadı.')

  if (side === 'buy') {
    if (trade.balance < amount) throw new Error('Yetersiz USDT bakiyesi.')
    trade.setBalance(Math.max(0, Math.round((trade.balance - amount) * 100) / 100))
    const res = dnz.buyDnz({
      qty: quote.tokenAmount,
      price: quote.usdtAmount / quote.tokenAmount,
      usdtCost: amount,
    })
    if (!res.ok) throw new Error(res.error)
  } else {
    if (dnz.balance < amount) throw new Error('Yetersiz coin bakiyesi.')
    const res = dnz.sellDnz({
      qty: amount,
      price: quote.usdtAmount / quote.tokenAmount,
    })
    if (!res.ok) throw new Error(res.error)
    trade.setBalance(Math.round((trade.balance + quote.usdtAmount) * 100) / 100)
  }

  pools['DNZ'] = {
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
 * - DNZ: aynı imza/matematik, yerleşim `applyDnzTrade` /
 *   `execute_dnz_trade` (dnz defterleri + mum upsert).
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

  if (symbol === 'DNZ') {
    if (isSupabaseConfigured && supabase) {
      const { data, error } = await supabase.rpc('execute_dnz_trade', {
        p_user_id: userId,
        p_side: side,
        p_amount: amount,
      })
      if (error) {
        if ((error as { code?: string }).code === 'PGRST202') {
          throw new Error(
            "DNZ havuz altyapısı veritabanında yok. Yönetici Supabase SQL Editor'de 20260918180000_dnz_amm_pool migration'ını uygulamalı.",
          )
        }
        throw new Error(mapRpcError(error))
      }
      const r = data as Record<string, unknown> | null
      if (!r || r.ok !== true) throw new Error('İşlem gerçekleştirilemedi.')
      try {
        await useDnzStore.getState().refreshRemote()
      } catch {
        // yoksay — sunucu doğruluk kaynağı, önbellek sonra yakalar
      }
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
    const pool = pools['DNZ']
    if (!pool) throw new Error('Coin bulunamadı.')
    const quote =
      side === 'buy'
        ? quoteVirtualBuy(
            { symbol: 'DNZ', reserveUsdt: pool.reserveUsdt, reserveToken: pool.reserveToken },
            amount,
          )
        : quoteVirtualSell(
            { symbol: 'DNZ', reserveUsdt: pool.reserveUsdt, reserveToken: pool.reserveToken },
            amount,
          )
    return applyDnzTrade(side, amount, quote)
  }

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
  // Başlangıç her zaman pozitif kalır (büyük limitlerde de).
  const span = Math.min(0.9, 0.02 * Math.max(limit, 1))
  let p = price <= 0 ? 1 : price / (1 + (rand() - 0.5) * span)
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

/**
 * Bot havuz hamlesi (USDT cinsinden balina hareketi).
 * Kullanıcı bakiyesine DOKUNMAZ — yalnızca havuzu oynatır (rezerv +
 * fiyat + hacim + mum). Uzak modda `execute_bot_trade` RPC'si (süper
 * admin zorunlu), yerel modda aynı matematik doğrudan havuza uygulanır.
 * - buy:  usdtAmount havuza girer.
 * - sell: usdtAmount havuzdan çıkar (gerekli token tersine çözülür).
 */
export async function executeBotPoolTrade(
  symbol: string,
  side: VirtualTradeSide,
  usdtAmount: number,
): Promise<VirtualTradeResult> {
  if (!Number.isFinite(usdtAmount) || usdtAmount <= 0) {
    throw new Error('Geçersiz tutar.')
  }
  const userId = getSessionUserId()
  if (!userId) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('execute_bot_trade', {
      p_symbol: symbol,
      p_trade_type: side,
      p_usdt_amount: usdtAmount,
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

  const pools = readPools()
  const pool = pools[symbol]
  if (!pool) throw new Error('Coin bulunamadı.')
  const quote =
    side === 'buy'
      ? quoteVirtualBuy(
          { symbol, reserveUsdt: pool.reserveUsdt, reserveToken: pool.reserveToken },
          usdtAmount,
        )
      : quoteVirtualSellForUsdt(
          { symbol, reserveUsdt: pool.reserveUsdt, reserveToken: pool.reserveToken },
          usdtAmount,
        )
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
