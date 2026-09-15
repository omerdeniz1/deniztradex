import { isSupabaseConfigured, supabase } from '@/lib/supabase'

/**
 * Leaderboard (Sıralama) veri katmanı — SADECE Supabase.
 *
 * Skor sunucuda hesaplanır (`get_leaderboard` RPC): portföy %40, hacim %30,
 * performans %30 ağırlıklı, 0-100 aralığında. RPC herkese açık vitrin
 * kolonları döndürür (e-posta/id sızmaz), yasaklı hesapları dışlar.
 * Çevrimdışı/test modunda hata fırlatılır — sessiz fallback yoktur.
 */

export interface TraderEntry {
  rank: number
  username: string
  avatarUrl: string | null
  isAdmin: boolean
  isSubAdmin: boolean
  balance: number
  volume: number
  pnl: number
  trades: number
  score: number
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? (n as number) : 0
}

interface LeaderboardRow {
  username: string
  avatar_url: unknown
  is_admin: unknown
  has_permissions: unknown
  balance: number | string | null
  volume: number | string | null
  pnl: number | string | null
  trades: number | string | null
  score: number | string | null
}

/** Sıralama (skor azalan). En fazla 100 kayıt döner. */
export async function getLeaderboard(limit = 50): Promise<TraderEntry[]> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Sıralama çevrimdışı kullanılamaz. Bağlantını kontrol edip tekrar dene.')
  }
  const { data, error } = await supabase.rpc('get_leaderboard', {
    p_limit: Math.min(Math.max(limit, 1), 100),
  })
  if (error) {
    throw new Error('Sıralama yüklenemedi. Lütfen tekrar dene.')
  }
  if (!Array.isArray(data)) return []
  return (data as LeaderboardRow[]).map((r, i) => ({
    rank: i + 1,
    username: (r.username ?? '').trim() || 'Kullanıcı',
    avatarUrl:
      typeof r.avatar_url === 'string' && r.avatar_url ? r.avatar_url : null,
    isAdmin: r.is_admin === true,
    isSubAdmin: r.is_admin !== true && r.has_permissions === true,
    balance: toNumber(r.balance),
    volume: toNumber(r.volume),
    pnl: toNumber(r.pnl),
    trades: Math.max(0, Math.floor(toNumber(r.trades))),
    score: toNumber(r.score),
  }))
}
