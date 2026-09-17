import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import type { Position } from '@/types'
import type { SpotPosition, SpotTrade, TradeRecord } from '@/store/tradeStore'
import type { OrderSpec } from '@/store/orderStore'

/**
 * Cihazlar arası işlem senkronu — `trading_state` tablosu (kullanıcı
 * başına tek satır). Mobilde açılan pozisyon/emir masaüstüne, masaüstünde
 * açılan mobile düşer. Bakiye bu yolla taşınmaz (`profiles.balance`
 * zaten `useProfileSync` ile senkron).
 *
 * Çevrimdışıyken tüm çağrılar sessizce boş döner (yerel mod etkilenmez).
 */

export interface TradingSnapshot {
  positions: Position[]
  spotBalances: Record<string, number>
  spotPositions: SpotPosition[]
  pendingOrders: OrderSpec[]
  trades: TradeRecord[]
  spotTrades: SpotTrade[]
  /** Sunucu satırının zamanı (ms). Yoksa 0. */
  updatedAt: number
}

export const EMPTY_SNAPSHOT: TradingSnapshot = {
  positions: [],
  spotBalances: {},
  spotPositions: [],
  pendingOrders: [],
  trades: [],
  spotTrades: [],
  updatedAt: 0,
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cleanPositions(v: unknown): Position[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (p): p is Position =>
      isRecord(p) &&
      typeof p.id === 'string' &&
      typeof p.symbol === 'string' &&
      (p.side === 'long' || p.side === 'short') &&
      Number.isFinite(p.quantity) &&
      Number.isFinite(p.entryPrice),
  )
}

function cleanSpotBalances(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      out[k.toUpperCase()] = val
    }
  }
  return out
}

function cleanSpotPositions(v: unknown): SpotPosition[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (p): p is SpotPosition =>
      isRecord(p) &&
      typeof p.id === 'string' &&
      typeof p.symbol === 'string' &&
      Number.isFinite(p.quantity) &&
      Number.isFinite(p.entryPrice),
  )
}

function cleanOrders(v: unknown): OrderSpec[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (o): o is OrderSpec =>
      isRecord(o) &&
      typeof o.id === 'string' &&
      typeof o.symbol === 'string' &&
      Number.isFinite(o.quantity) &&
      Number.isFinite(o.entryPrice),
  )
}

function cleanTrades(v: unknown): TradeRecord[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(
      (t): t is TradeRecord =>
        isRecord(t) &&
        typeof t.id === 'string' &&
        typeof t.symbol === 'string' &&
        Number.isFinite(t.quantity),
    )
    .slice(0, 200)
}

function cleanSpotTrades(v: unknown): SpotTrade[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(
      (t): t is SpotTrade =>
        isRecord(t) &&
        typeof t.id === 'string' &&
        typeof t.symbol === 'string' &&
        Number.isFinite(t.quantity),
    )
    .slice(0, 200)
}

/** Sunucudaki anlık görüntüyü oku (yoksa boş). Asla fırlatmaz. */
export async function loadTradingState(userId: string): Promise<TradingSnapshot> {
  if (!isSupabaseConfigured || !supabase || !userId) return { ...EMPTY_SNAPSHOT }
  try {
    const { data, error } = await supabase
      .from('trading_state')
      .select('positions,spot_balances,spot_positions,pending_orders,trades,spot_trades,updated_at')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return { ...EMPTY_SNAPSHOT }
    const row = data as {
      positions?: unknown
      spot_balances?: unknown
      spot_positions?: unknown
      pending_orders?: unknown
      trades?: unknown
      spot_trades?: unknown
      updated_at?: unknown
    }
    return {
      positions: cleanPositions(row.positions),
      spotBalances: cleanSpotBalances(row.spot_balances),
      spotPositions: cleanSpotPositions(row.spot_positions),
      pendingOrders: cleanOrders(row.pending_orders),
      trades: cleanTrades(row.trades),
      spotTrades: cleanSpotTrades(row.spot_trades),
      updatedAt: Date.parse(String(row.updated_at ?? '')) || 0,
    }
  } catch {
    return { ...EMPTY_SNAPSHOT }
  }
}

export interface TradingPush {
  positions: Position[]
  spotBalances: Record<string, number>
  spotPositions: SpotPosition[]
  pendingOrders: OrderSpec[]
  trades: TradeRecord[]
  spotTrades: SpotTrade[]
}

/** Yerel durumu sunucuya yaz (upsert). Asla fırlatmaz. */
export async function saveTradingState(userId: string, snap: TradingPush): Promise<number | null> {
  if (!isSupabaseConfigured || !supabase || !userId) return null
  try {
    const now = new Date().toISOString()
    const { error } = await supabase.from('trading_state').upsert(
      {
        user_id: userId,
        positions: snap.positions,
        spot_balances: snap.spotBalances,
        spot_positions: snap.spotPositions,
        pending_orders: snap.pendingOrders,
        trades: snap.trades.slice(0, 200),
        spot_trades: snap.spotTrades.slice(0, 200),
        updated_at: now,
      },
      { onConflict: 'user_id' },
    )
    if (error) return null
    return Date.parse(now) || Date.now()
  } catch {
    return null
  }
}
