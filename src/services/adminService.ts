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
  { key: 'restrict_money', label: 'Para İşlemlerini Kısıtlayabilir' },
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
  depositBlocked: boolean
  withdrawBlocked: boolean
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
    // RPC/trigger raise'leri Türkçe gelir ("yetkisiz işlem: ...",
    // "kendi ...", "süper admin ..."). PostgREST sarmalayıcısını
    // temizleyip aynen göster.
    const clean = msg.replace(/^.*?:\s*\{?"message":"?/, '').replace(/"?\}?\s*$/, '')
    if (/yetkisiz|kendi|bulunamadı|geçersiz|giriş gerekli|süper admin/i.test(clean)) {
      return new Error(clean)
    }
    if (/yetkisiz|kendi|bulunamadı|geçersiz|giriş gerekli|süper admin/i.test(msg)) {
      return new Error(msg)
    }
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
  deposit_blocked: unknown
  withdraw_blocked: unknown
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
    depositBlocked: row.deposit_blocked === true,
    withdrawBlocked: row.withdraw_blocked === true,
    createdAt: Date.parse(row.created_at) || 0,
  }
}

/** Tüm kayıtlı kullanıcılar (panelei görebilen yöneticiler). */
export async function listAdminUsers(): Promise<AdminUser[]> {
  const { client } = await requireAccess()
  const { data, error } = await client
    .from('profiles')
    .select('id,username,email,balance,is_admin,is_frozen,is_banned,admin_permissions,avatar_url,deposit_blocked,withdraw_blocked,created_at')
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
 * Para yatırma / çekme kısıtlaması (`restrict_money` gerekir, RPC denetimli).
 * Kısıtlı kullanıcı giriş yapmaya ve işlem yapmaya devam eder; yalnızca
 * ilgili para yönü kapatılır.
 */
export async function setMoneyRestrictions(
  userId: string,
  input: { depositBlocked: boolean; withdrawBlocked: boolean },
): Promise<void> {
  if (!userId) throw new Error('Kullanıcı bulunamadı.')
  const { client } = await requireAccess('restrict_money')
  const { error } = await client.rpc('admin_update_profile', {
    p_user_id: userId,
    p_deposit_blocked: input.depositBlocked,
    p_withdraw_blocked: input.withdrawBlocked,
  })
  if (error) throw toRpcError(error, 'Kısıtlama güncellenemedi. Lütfen tekrar dene.')
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
  const { client, access } = await requireAccess('change_password')
  // Süper admin hesabına yalnız süper admin dokunur (taciz/zarar koruması).
  if (!access.isSuperAdmin) {
    try {
      const { data } = await client
        .from('profiles')
        .select('is_admin')
        .ilike('email', target)
        .maybeSingle()
      if ((data as { is_admin?: unknown } | null)?.is_admin === true) {
        throw new Error('Süper admin hesabına müdahale edemezsin.')
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'Süper admin hesabına müdahale edemezsin.') {
        throw err
      }
      // Okuma hatası = engel değil (asıl denetim sunucuda); devam et.
    }
  }
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
  /** Yazar süper admin mi? (süper olmayan moderatör dokunamaz) */
  authorIsAdmin: boolean
  createdAt: number
}

/** Denetim için en yeni forum yazıları (panelei görebilen yöneticiler). */
export async function listForumAdminPosts(limit = 50): Promise<AdminForumPost[]> {
  const { client } = await requireAccess()
  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const { data, error } = await client
    .from('forum_posts')
    .select('id,user_id,username,content,like_count,reply_count,created_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit)
  if (error) throw new Error('Forum yazıları yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
  const rows = data as {
    id: string
    user_id: string
    username: string
    content: string
    like_count: number
    reply_count: number
    created_at: string
  }[]
  // Yazarların süper admin bayrağı tek sorguda (görünürlük kapısı için).
  let superIds = new Set<string>()
  const authorIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))]
  if (authorIds.length > 0) {
    try {
      const { data: profs } = await client
        .from('profiles')
        .select('id,is_admin')
        .in('id', authorIds)
      if (Array.isArray(profs)) {
        superIds = new Set(
          (profs as { id: string; is_admin?: unknown }[])
            .filter((p) => p.is_admin === true)
            .map((p) => p.id),
        )
      }
    } catch {
      // Okunamazsa hepsi dokunulabilir sayılır; asıl denetim sunucuda.
    }
  }
  return rows.map((r) => ({
    id: r.id,
    username: (r.username ?? '').trim() || 'Kullanıcı',
    content: r.content ?? '',
    replyCount: r.reply_count ?? 0,
    likeCount: r.like_count ?? 0,
    authorIsAdmin: superIds.has(r.user_id),
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

// ---------------------------------------------------------------
// Altcoin Yönetimi (süper admin)
// ---------------------------------------------------------------

export type CoinStatus = 'normal' | 'promoted' | 'demoted'

export interface VirtualCoin {
  symbol: string
  name: string
  type: 'crypto' | 'commodity'
  reserveUsdt: number
  reserveToken: number
  currentPrice: number
  volume24h: number
  status: CoinStatus
}

export interface CoinNewsItem {
  id: string
  symbol: string
  title: string
  body: string
  createdAt: number
}

export interface CoinWithNews {
  coin: VirtualCoin
  news: CoinNewsItem[]
}

/** Tüm sanal coinler (süper admin). */
export async function listVirtualCoins(): Promise<VirtualCoin[]> {
  const { client } = await requireAccess()
  const { data, error } = await client
    .from('virtual_coins')
    .select('symbol,name,type,reserve_usdt,reserve_token,current_price,volume_24h,status')
    .order('symbol')
  if (error) throw new Error('Coinler yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
  return (data as {
    symbol: string
    name: string
    type: 'crypto' | 'commodity'
    reserve_usdt: number | string
    reserve_token: number | string
    current_price: number | string
    volume_24h: number | string
    status: CoinStatus
  }[]).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    type: r.type,
    reserveUsdt: Number(r.reserve_usdt),
    reserveToken: Number(r.reserve_token),
    currentPrice: Number(r.current_price),
    volume24h: Number(r.volume_24h),
    status: r.status,
  }))
}

/** Coin durumu güncelle (promote/demote) + haber ekle (süper admin). */
export async function updateCoinStatus(
  symbol: string,
  status: CoinStatus,
  newsTitle?: string,
  newsBody?: string
): Promise<CoinWithNews> {
  const { client } = await requireAccess()
  const { data, error } = await client.rpc('admin_update_coin', {
    p_symbol: symbol,
    p_status: status,
    p_news_title: newsTitle ?? null,
    p_news_body: newsBody ?? null,
  })
  if (error) throw new Error('Coin güncellenemedi. Lütfen tekrar dene.')
  if (!data) throw new Error('Beklenmeyen yanıt.')
  const row = data as {
    ok: boolean
    symbol: string
    status: CoinStatus
    news: {
      id: string
      title: string
      body: string
      created_at: string
    }[]
  }
  return {
    coin: {
      symbol: row.symbol,
      name: '',
      type: 'crypto',
      reserveUsdt: 0,
      reserveToken: 0,
      currentPrice: 0,
      volume24h: 0,
      status: row.status,
    },
    news: (row.news ?? []).map((n) => ({
      id: n.id,
      symbol: row.symbol,
      title: n.title,
      body: n.body,
      createdAt: Date.parse(n.created_at) || 0,
    })),
  }
}

export async function listCoinNews(symbol: string, limit = 20): Promise<CoinNewsItem[]> {
  const { client } = await requireAccess()
  const { data, error } = await client
    .from('coin_news')
    .select('id,symbol,title,body,created_at')
    .ilike('symbol', symbol.trim() || '___none___')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error('Haberler yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
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
}

export interface CoinOverride {
  symbol: string
  status: CoinStatus
}

/**
 * TÜM sembollerin durumları (sanal + gerçek). `coin_overrides` tablosu
 * herhangi bir sembolü kapsar; sanal coinlerde havuz satırı da aynı
 * değeri taşır (eski okuyucular için senkron tutulur).
 */
export async function listCoinOverrides(): Promise<CoinOverride[]> {
  const { client } = await requireAccess()
  const { data, error } = await client
    .from('coin_overrides')
    .select('symbol,status')
    .order('symbol')
  if (error) throw new Error('Coin durumları yüklenemedi. Lütfen tekrar dene.')
  if (!Array.isArray(data)) return []
  return (data as { symbol: string; status: CoinStatus }[]).map((r) => ({
    symbol: (r.symbol ?? '').toUpperCase(),
    status: r.status === 'promoted' || r.status === 'demoted' ? r.status : 'normal',
  }))
}

/** Coin haberi sil (süper admin). */
export async function deleteCoinNews(newsId: string): Promise<void> {
  const { client } = await requireAccess()
  const { error } = await client.rpc('admin_delete_coin_news', {
    p_news_id: newsId,
  })
  if (error) throw new Error('Haber silinemedi. Lütfen tekrar dene.')
}