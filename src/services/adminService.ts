import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'
import { deleteForumPost } from '@/services/forumService'

/**
 * Admin Panel veri katmanı — SADECE Supabase.
 *
 * Yetki modeli (RBAC):
 *  - `is_admin = true` → süper admin (tüm yetkiler).
 *  - `admin_permissions` dizisi dolu → alt yönetici (yalnızca listedeki
 *    yetkiler). Geçerli izinler `ADMIN_PERMISSIONS` altında tanımlı.
 *
 * Yetki DB'den gelir: istemcideki hiçbir bayrak yetki sayılmaz. Tüm
 * yazımlar `admin_update_profile` RPC'sinden geçer ve sunucu tarafında
 * alan bazında denetlenir; RLS + ayrıcalık koruma tetikleyicisi ikinci
 * savunma hattıdır.
 *
 * Supabase yapılandırılmamışsa (vitest / çevrimdışı) tüm çağrılar hata
 * fırlatır — admin paneli yerelde çalışmaz, sessiz fallback yoktur.
 */

export const ADMIN_PERMISSIONS = [
  { key: 'edit_balance', label: 'Bakiye Düzenleyebilir' },
  { key: 'ban_users', label: 'Kullanıcı Banlayabilir' },
  { key: 'change_password', label: 'Şifre Değiştirebilir' },
  { key: 'manage_admins', label: 'Admin Ekleyebilir' },
] as const

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]['key']

export const ALL_ADMIN_PERMISSION_KEYS: AdminPermission[] = ADMIN_PERMISSIONS.map((p) => p.key)

export interface AdminAccess {
  isSuperAdmin: boolean
  permissions: AdminPermission[]
}

/** Saf istemci tarafı kontrol (görünürlük kapısı; gerçek denetim sunucuda). */
export function hasAdminPermission(access: AdminAccess, perm: AdminPermission): boolean {
  return access.isSuperAdmin || access.permissions.includes(perm)
}

function sanitizePermissions(input: unknown): AdminPermission[] {
  if (!Array.isArray(input)) return []
  const valid = new Set<string>(ALL_ADMIN_PERMISSION_KEYS)
  const out: AdminPermission[] = []
  for (const p of input) {
    if (typeof p === 'string' && valid.has(p) && !out.includes(p as AdminPermission)) {
      out.push(p as AdminPermission)
    }
  }
  return out
}

export interface AdminUser {
  id: string
  username: string
  email: string
  balance: number
  isAdmin: boolean
  isFrozen: boolean
  isBanned: boolean
  permissions: AdminPermission[]
  avatarUrl: string | null
  createdAt: number
}

export interface PlatformStats {
  totalUsers: number
  totalBalance: number
  forumPosts: number
  transactionsToday: number
  frozenCount: number
  bannedCount: number
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

/** Giriş yapmış kullanıcının admin erişimi (DB'den okunur). */
export async function getMyAdminAccess(): Promise<AdminAccess> {
  const none: AdminAccess = { isSuperAdmin: false, permissions: [] }
  const session = getSessionUser()
  if (!session) return none
  if (!isSupabaseConfigured || !supabase) return none
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('is_admin,admin_permissions')
      .eq('id', session.id)
      .maybeSingle()
    if (error || !data) return none
    const row = data as { is_admin?: unknown; admin_permissions?: unknown }
    return {
      isSuperAdmin: row.is_admin === true,
      permissions: sanitizePermissions(row.admin_permissions),
    }
  } catch {
    return none
  }
}

/** Panelei görebilir mi? (süper admin veya en az bir izinli alt yönetici) */
export async function checkIsAdmin(): Promise<boolean> {
  const access = await getMyAdminAccess()
  return access.isSuperAdmin || access.permissions.length > 0
}

async function requireAccess(perm?: AdminPermission): Promise<{
  client: NonNullable<typeof supabase>
  myId: string
  access: AdminAccess
}> {
  const client = requireBackend()
  const session = getSessionUser()
  if (!session) throw new Error('Admin paneline erişmek için giriş yapmalısın.')
  const access = await getMyAdminAccess()
  if (!access.isSuperAdmin && access.permissions.length === 0) {
    throw new Error('Bu sayfaya erişim yetkin yok.')
  }
  if (perm && !hasAdminPermission(access, perm)) {
    throw new Error('Bu işlem için yetkin yok.')
  }
  return { client, myId: session.id, access }
}

function toRpcError(err: unknown, fallback: string): Error {
  const msg = (err as { message?: unknown } | null)?.message
  if (typeof msg === 'string' && msg.trim()) {
    // RPC raise'leri Türkçe gelir ("yetkisiz işlem: ...", "kendi ...").
    // PostgREST sarmalayıcısını temizleyip aynen göster.
    const clean = msg.replace(/^.*?:\s*\{?"message":"?/, '').replace(/"?\}?\s*$/, '')
    if (/yetkisiz|kendi|bulunamadı|geçersiz|giriş gerekli/i.test(clean)) return new Error(clean)
    if (/yetkisiz|kendi|bulunamadı|geçersiz|giriş gerekli/i.test(msg)) return new Error(msg)
  }
  return new Error(fallback)
}

interface AdminRow {
  id: string
  username: string
  email: string
  balance: number | string | null
  is_admin: unknown
  is_frozen: unknown
  is_banned: unknown
  admin_permissions: unknown
  avatar_url: unknown
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
    isBanned: row.is_banned === true,
    permissions: sanitizePermissions(row.admin_permissions),
    avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url ? row.avatar_url : null,
    createdAt: Date.parse(row.created_at) || 0,
  }
}

/** Tüm kayıtlı kullanıcılar (panelei görebilen yöneticiler). */
export async function listAdminUsers(): Promise<AdminUser[]> {
  const { client } = await requireAccess()
  const { data, error } = await client
    .from('profiles')
    .select('id,username,email,balance,is_admin,is_frozen,is_banned,admin_permissions,avatar_url,created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error('Kullanıcılar yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
  return (data as AdminRow[]).map(toAdminUser)
}

/** Platform geneli özet kartları (panelei görebilen yöneticiler). */
export async function getPlatformStats(): Promise<PlatformStats> {
  const { client } = await requireAccess()

  const [usersRes, postsRes, txRes] = await Promise.all([
    client.from('profiles').select('id,balance,is_frozen,is_banned', { count: 'exact' }).limit(2000),
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
    is_banned: unknown
  }[]
  return {
    totalUsers: usersRes.count ?? rows.length,
    totalBalance: rows.reduce((sum, r) => sum + toBalance(r.balance), 0),
    forumPosts: postsRes.count ?? 0,
    transactionsToday: txRes.count ?? 0,
    frozenCount: rows.filter((r) => r.is_frozen === true).length,
    bannedCount: rows.filter((r) => r.is_banned === true).length,
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

/** Kullanıcının bakiyesini günceller (`edit_balance` gerekir, RPC denetimli). */
export async function updateUserBalance(userId: string, newBalance: number): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  if (!Number.isFinite(newBalance) || newBalance < 0) {
    throw new Error('Geçerli bir bakiye gir (0 veya daha büyük bir sayı).')
  }
  const { client } = await requireAccess('edit_balance')
  const { error } = await client.rpc('admin_update_profile', {
    p_user_id: userId,
    p_balance: newBalance,
  })
  if (error) throw toRpcError(error, 'Bakiye güncellenemedi. Lütfen tekrar dene.')
}

/** Hesabı dondurur / çözer (`ban_users` gerekir, RPC denetimli). */
export async function setUserFrozen(userId: string, frozen: boolean): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  const { client } = await requireAccess('ban_users')
  const { error } = await client.rpc('admin_update_profile', {
    p_user_id: userId,
    p_is_frozen: frozen,
  })
  if (error) throw toRpcError(error, 'Hesap durumu güncellenemedi. Lütfen tekrar dene.')
}

/** Hesabı kalıcı yasaklar / yasağı kaldırır (`ban_users` gerekir, RPC denetimli). */
export async function setUserBanned(userId: string, banned: boolean): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  const { client } = await requireAccess('ban_users')
  const { error } = await client.rpc('admin_update_profile', {
    p_user_id: userId,
    p_is_banned: banned,
  })
  if (error) throw toRpcError(error, 'Yasaklama işlemi yapılamadı. Lütfen tekrar dene.')
}

/**
 * Yönetici yetkisi atar / günceller / kaldırır (`manage_admins` gerekir).
 * `isAdmin=true` süper admin yapar; alt yönetici için izin listesi verilir.
 * Yetkileri tamamen kaldırmak için `permissions: []` + `isAdmin: false` geçilir.
 */
export async function setAdminPrivileges(
  userId: string,
  input: { isAdmin: boolean; permissions: AdminPermission[] },
): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  const perms = sanitizePermissions(input.permissions)
  const { client, myId } = await requireAccess('manage_admins')
  if (userId === myId) throw new Error('Kendi yetkilerini değiştiremezsin.')
  const { error } = await client.rpc('admin_update_profile', {
    p_user_id: userId,
    p_is_admin: input.isAdmin,
    p_permissions: perms,
  })
  if (error) throw toRpcError(error, 'Yetkiler güncellenemedi. Lütfen tekrar dene.')
}

/**
 * Şifre sıfırlama e-postası gönderir (`change_password` gerekir).
 *
 * Neden e-posta? Başka bir kullanıcının şifresini doğrudan yazmak yalnızca
 * service_role anahtarıyla (Admin API) mümkündür ve bu anahtar asla tarayıcıya
 * konmaz. Supabase'in yerleşik akışı kullanılır: kullanıcı e-postadaki
 * bağlantıyla kendi şifresini belirler — yönetici şifreyi hiç görmez.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  const target = email.trim()
  if (!target.includes('@')) throw new Error('Geçerli bir e-posta bulunamadı.')
  const { client } = await requireAccess('change_password')
  const { error } = await client.auth.resetPasswordForEmail(target)
  if (error) throw new Error('Sıfırlama e-postası gönderilemedi. Lütfen tekrar dene.')
}

// ---------------------------------------------------------------
// Forum denetimi: moderasyon yetkisi (`ban_users`) olan yöneticiler
// tüm yazıları tek tek veya toplu silebilir. Silme, forum
// servisinin RLS denetimli yolunu kullanır (satır dönmezse hata).
// ---------------------------------------------------------------

export interface AdminForumPost {
  id: string
  username: string
  content: string
  replyCount: number
  likeCount: number
  createdAt: number
}

/** Denetim için en yeni forum yazıları (panelei görebilen yöneticiler). */
export async function listForumAdminPosts(limit = 50): Promise<AdminForumPost[]> {
  const { client } = await requireAccess()
  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const { data, error } = await client
    .from('forum_posts')
    .select('id,username,content,like_count,reply_count,created_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit)
  if (error) throw new Error('Forum yazıları yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
  return (data as {
    id: string
    username: string
    content: string
    like_count: number
    reply_count: number
    created_at: string
  }[]).map((r) => ({
    id: r.id,
    username: (r.username ?? '').trim() || 'Kullanıcı',
    content: r.content ?? '',
    replyCount: r.reply_count ?? 0,
    likeCount: r.like_count ?? 0,
    createdAt: Date.parse(r.created_at) || 0,
  }))
}

/** Toplu silme (`ban_users` gerekir). Başarısızlar sayılır, yutulmaz. */
export async function deleteForumPostsBulk(ids: string[]): Promise<{ deleted: number; failed: number }> {
  await requireAccess('ban_users')
  const unique = [...new Set(ids.filter(Boolean))]
  let deleted = 0
  let failed = 0
  for (const id of unique) {
    try {
      await deleteForumPost(id)
      deleted += 1
    } catch {
      failed += 1
    }
  }
  return { deleted, failed }
}
