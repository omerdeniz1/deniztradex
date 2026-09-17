import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import type { CoinNewsItem, CoinOverride, CoinStatus } from '@/services/adminService'

/**
 * Coin meta verileri — HERKESE açık okuma (yükseltme/düşürme durumu +
 * coin haberleri). Yazım yalnızca admin panelindedir (adminService).
 *
 * Çevrimdışı/test modunda boş döner — piyasa listesi etkilenmez.
 */

function toStatus(value: unknown): CoinStatus {
  return value === 'promoted' || value === 'demoted' ? value : 'normal'
}

/** Tüm sembol durumları: symbol → status (yoksa 'normal' varsayılır). */
export async function listCoinOverridesPublic(): Promise<Record<string, CoinStatus>> {
  if (!isSupabaseConfigured || !supabase) return {}
  try {
    const { data, error } = await supabase.from('coin_overrides').select('symbol,status')
    if (error || !Array.isArray(data)) return {}
    const out: Record<string, CoinStatus> = {}
    for (const r of data as { symbol?: unknown; status?: unknown }[]) {
      if (typeof r.symbol === 'string' && r.symbol.trim()) {
        out[r.symbol.trim().toUpperCase()] = toStatus(r.status)
      }
    }
    return out
  } catch {
    return {}
  }
}

/** override listesini admin tipinde döndürür (panel dışı toplu okuma). */
export async function listCoinOverrideRows(): Promise<CoinOverride[]> {
  const map = await listCoinOverridesPublic()
  return Object.entries(map).map(([symbol, status]) => ({ symbol, status }))
}

/** Bir sembolün herkese açık haberleri (yeniden eskiye). */
export async function listCoinNewsPublic(symbol: string, limit = 5): Promise<CoinNewsItem[]> {
  const clean = symbol.trim().toUpperCase()
  if (!clean || !isSupabaseConfigured || !supabase) return []
  try {
    const { data, error } = await supabase
      .from('coin_news')
      .select('id,symbol,title,body,created_at')
      .ilike('symbol', clean)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 20))
    if (error || !Array.isArray(data)) return []
    return (data as {
      id: string
      symbol: string
      title: string
      body: string
      created_at: string
    }[]).map((r) => ({
      id: r.id,
      symbol: r.symbol,
      title: r.title,
      body: r.body,
      createdAt: Date.parse(r.created_at) || 0,
    }))
  } catch {
    return []
  }
}
