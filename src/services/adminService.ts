import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'

/**
 * Admin Panel veri katmanı — SADECE Supabase.
 *
 * Yetki DB'den gelir (`profiles.is_admin`): istemcideki hiçbir bayrak
 * yetki sayılmaz. Tüm okuma/yazma RLS ile korunur
 * (`profiles_admin_select` / `profiles_admin_update`); yetkisiz
 * istek Supabase tarafından reddedilir ve burada Türkçe hataya çevrilir.
 *
 * Supabase yapılandırılmamışsa (vitest / çevrimdışı) tüm çağrılar hata
 * fırlatır — admin paneli yerelde çalışmaz, sessiz fallback yoktur.
 */

export interface AdminUser {
  id: string
  username: string
  email: string
  balance: number
  isAdmin: boolean
  isFrozen: boolean
  createdAt: number
}

export interface PlatformStats {
  totalUsers: number
  totalBalance: number
  forumPosts: number
  transactionsToday: number
  frozenCount: number
}

function requireBackend() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Admin paneli çevrimdışı kullanılamaz. Supabase yapılandırması gerekli.')
  }
  return supabase
}

function toBalance(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : 0
}

/** Giriş yapmış kullanıcının yönetici olup olmadığı (DB'den okunur). */
export async function checkIsAdmin(): Promise<boolean> {
  const session = getSessionUser()
  if (!session) return false
  if (!isSupabaseConfigured || !supabase) return false
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', session.id)
      .maybeSingle()
    if (error || !data) return false
    return (data as { is_admin?: unknown }).is_admin === true
  } catch {
    return false
  }
}

async function requireAdmin(): Promise<{ client: NonNullable<typeof supabase>; myId: string }> {
  const client = requireBackend()
  const session = getSessionUser()
  if (!session) throw new Error('Admin paneline erişmek için giriş yapmalısın.')
  const ok = await checkIsAdmin()
  if (!ok) throw new Error('Bu sayfaya erişim yetkin yok.')
  return { client, myId: session.id }
}

interface AdminRow {
  id: string
  username: string
  email: string
  balance: number | string | null
  is_admin: unknown
  is_frozen: unknown
  created_at: string
}

function toAdminUser(row: AdminRow): AdminUser {
  return {
    id: row.id,
    username: (row.username ?? '').trim() || 'Kullanıcı',
    email: (row.email ?? '').trim(),
    balance: toBalance(row.balance),
    isAdmin: row.is_admin === true,
    isFrozen: row.is_frozen === true,
    createdAt: Date.parse(row.created_at) || 0,
  }
}

/** Tüm kayıtlı kullanıcılar (yönetici yetkisi gerekir). */
export async function listAdminUsers(): Promise<AdminUser[]> {
  const { client } = await requireAdmin()
  const { data, error } = await client
    .from('profiles')
    .select('id,username,email,balance,is_admin,is_frozen,created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error('Kullanıcılar yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
  return (data as AdminRow[]).map(toAdminUser)
}

/** Platform geneli özet kartları (yönetici yetkisi gerekir). */
export async function getPlatformStats(): Promise<PlatformStats> {
  const { client } = await requireAdmin()

  const [usersRes, postsRes, txRes] = await Promise.all([
    client.from('profiles').select('id,balance,is_frozen', { count: 'exact' }).limit(2000),
    client.from('forum_posts').select('id', { count: 'exact', head: true }),
    client
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
  ])
  if (usersRes.error) throw new Error('İstatistikler yüklenemedi. Lütfen tekrar dene.')

  const rows = (Array.isArray(usersRes.data) ? usersRes.data : []) as {
    balance: number | string | null
    is_frozen: unknown
  }[]
  return {
    totalUsers: usersRes.count ?? rows.length,
    totalBalance: rows.reduce((sum, r) => sum + toBalance(r.balance), 0),
    forumPosts: postsRes.count ?? 0,
    transactionsToday: txRes.count ?? 0,
    frozenCount: rows.filter((r) => r.is_frozen === true).length,
  }
}

export function validateBalanceInput(raw: string): number {
  const normalized = raw.trim().replace(',', '.')
  // Number('') === 0 tuzağı: boş girdi açıkça reddedilir.
  if (!normalized) {
    throw new Error('Geçerli bir bakiye gir (0 veya daha büyük bir sayı).')
  }
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Geçerli bir bakiye gir (0 veya daha büyük bir sayı).')
  }
  return Math.round(value * 100) / 100
}

/** Kullanıcının bakiyesini günceller (yönetici yetkisi gerekir). */
export async function updateUserBalance(userId: string, newBalance: number): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  if (!Number.isFinite(newBalance) || newBalance < 0) {
    throw new Error('Geçerli bir bakiye gir (0 veya daha büyük bir sayı).')
  }
  const { client } = await requireAdmin()
  const { error } = await client.from('profiles').update({ balance: newBalance }).eq('id', userId)
  if (error) throw new Error('Bakiye güncellenemedi. Lütfen tekrar dene.')
}

/** Hesabı dondurur / çözer (yönetici yetkisi gerekir). */
export async function setUserFrozen(userId: string, frozen: boolean): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  const { client, myId } = await requireAdmin()
  if (userId === myId) throw new Error('Kendi hesabını donduramazsın.')
  const { error } = await client.from('profiles').update({ is_frozen: frozen }).eq('id', userId)
  if (error) throw new Error('Hesap durumu güncellenemedi. Lütfen tekrar dene.')
}
