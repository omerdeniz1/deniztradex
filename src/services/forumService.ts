import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'

/**
 * Forum (Topluluk) veri katmanı — tek kaynak Supabase, çevrimdışı yedekli.
 *
 * Supabase yapılandırıldığında (`forum_posts` / `forum_likes` tabloları +
 * `toggle_forum_like` RPC'si) TEK kaynak Supabase'tir: tüm cihazlar
 * (masaüstü + mobil) aynı akışı görür, hiçbir şey cihaza özel
 * localStorage'a yazılmaz ve kendiliğinden silinmez.
 *
 * Yerel depolama SADECE Supabase yapılandırılmadığında
 * (vitest / çevrimdışı) kullanılır; testler deterministik ve ağsız kalır.
 * Uzak hata gizlenip yerele düşülmez — aksi halde masaüstünde
 * paylaşılan mobilde görünmez (ve tersi), akış iki kaynak arasında
 * gidip gelip "silinmiş" gibi görünürdü.
 */

export const FORUM_POST_MAX_LENGTH = 5000
const FORUM_LOCAL_KEY = 'deniztradx_forum_posts_v1'
const FORUM_FEED_LIMIT = 50

/** Supabase varken uzak moddayız: yerel depolamaya asla düşme. */
function isRemoteMode(): boolean {
  return isSupabaseConfigured && supabase !== null
}

/**
 * Uzak hataları kullanıcı diline çevirir.
 *
 * Neden gerekli? Eskiden her hata gizlenip yerele düşülüyordu; şimdi hata
 * aynen gösteriliyor ama ham PostgREST metni ("PGRST205 ... schema cache")
 * kullanıcıya bir şey anlatmaz. Bu sınıflandırıcı üç durumu ayırt eder:
 *  1) kurulum eksik (forum tabloları/RPC veritabanında yok),
 *  2) oturum sorunu (RLS reddi / süresi dolmuş token),
 *  3) ağ/bağlantı sorunu.
 */
export function classifyForumRemoteError(err: unknown, action: string): Error {
  const raw = (err ?? {}) as {
    code?: unknown
    status?: unknown
    message?: unknown
    details?: unknown
    hint?: unknown
  }
  const code = String(raw.code ?? '').toUpperCase()
  const status = Number(raw.status ?? 0)
  const text = `${String(raw.message ?? '')} ${String(raw.details ?? '')} ${String(raw.hint ?? '')}`.toLowerCase()

  const mentionsSchemaCache =
    text.includes('schema cache') ||
    code === 'PGRST205' || // tablo yok
    code === 'PGRST202' || // fonksiyon yok
    code === 'PGRST200' ||
    code === '42P01' // relation does not exist
  if (mentionsSchemaCache || status === 404) {
    return new Error(
      `${action}: forum tabloları veritabanında bulunamadı (kurulum eksik). ` +
        `Yönetici Supabase SQL Editor'de APPLY_ALL_PENDING.sql dosyasını çalıştırmalı.`,
    )
  }

  const isAuthProblem =
    status === 401 ||
    status === 403 ||
    code === '42501' || // RLS ihlali
    code === 'PGRST301' ||
    text.includes('row-level security') ||
    text.includes('jwt') ||
    text.includes('token') ||
    text.includes('auth') ||
    text.includes('permission') ||
    text.includes('not authenticated')
  if (isAuthProblem) {
    return new Error(
      `${action}: oturum doğrulanamadı. Çıkış yapıp tekrar giriş yap, sonra dene.`,
    )
  }

  if (
    err instanceof TypeError ||
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('fetch')
  ) {
    return new Error(`${action}: bağlantı kurulamadı. İnternetini kontrol edip tekrar dene.`)
  }

  // Bilinmeyen iç hata ya da Supabase dışı hata: ham detayı sızdırma.
  const looksLikeSupabase = code !== '' || status !== 0
  const detail = String(raw.message ?? '').trim()
  if (looksLikeSupabase && detail && detail !== 'Failed to fetch') {
    return new Error(`${action}: ${detail}`)
  }
  return new Error(`${action}. Lütfen tekrar dene.`)
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** uid / uuid görünümlü değer mi? UI'da bunlar asla gösterilmemeli. */
function isUidLike(value: string): boolean {
  const v = value.trim()
  if (!v) return true
  if (UUID_RE.test(v)) return true
  if (v.startsWith('usr_')) return true
  if (/^[0-9a-f]{24,}$/i.test(v)) return true
  return false
}

/**
 * UI'da gösterilecek isim: kayıtlı kullanıcı adı. Kayıt boşsa ya da
 * yanlışlıkla uid yazılmışsa ("show uid" bug'ı) kullanıcı adı yerine
 * okunabilir bir isim döndürür — UI'da asla ham uid görünmez.
 */
export function forumDisplayName(username: string, userId: string): string {
  const name = (username ?? '').trim()
  if (name && name !== userId && !isUidLike(name)) return name
  const id = (userId ?? '').trim()
  if (id && !isUidLike(id) && id !== 'deniztradex') return id
  if (id.toLowerCase() === 'deniztradex') return 'DenizTradeX'
  return 'Kullanıcı'
}

/** Uzağa yazarken kullanılacak isim: boş/uid ise e-posta ön-ekine düş. */
function resolveWriteUsername(user: { id: string; username: string; email?: string }): string {
  const name = (user.username ?? '').trim()
  if (name && name !== user.id && !isUidLike(name)) return name
  const email = (user.email ?? '').trim()
  if (email.includes('@')) {
    const prefix = email.split('@')[0].trim()
    if (prefix && !isUidLike(prefix)) return prefix
  }
  if (user.id && !isUidLike(user.id)) return user.id
  return 'Kullanıcı'
}

export type VerifiedTier = 'none' | 'admin' | 'super'

/** Sunucudan gelen rozet değerini güvenli aralığa indirger. */
export function parseVerifiedTier(value: unknown): VerifiedTier {
  return value === 'super' || value === 'admin' ? value : 'none'
}

/**
 * Görünen isim çözümleyici: sunucu damgası (`display_name`) varsa o,
 * yoksa (eski DB) kullanıcı adı. Profilde belirlenen isim forumda
 * BÖYLE görünür; altında `@kullanıcıadı` yazılır.
 */
export function displayNameOf(row: Record<string, unknown>, username: string): string {
  const d = optText(row, 'display_name')
  return d ?? username
}

export interface ForumPost {
  id: string
  userId: string
  username: string
  /** Profilde belirlenen görünen isim (yoksa kullanıcı adıyla aynı). */
  displayName: string
  content: string
  likeCount: number
  likedByMe: boolean
  replyCount: number
  /** Rozet seviyesi: super → sarı tik, admin → mavi tik, none → rozetsiz. */
  verifiedTier: VerifiedTier
  /** Profil fotoğrafı URL'i (yoksa null → baş harf gösterilir). */
  avatarUrl: string | null
  /** İsim altında görünen özel etiket (yoksa null → rozet gösterilmez). */
  userTag: string | null
  /** Gönderi fotoğrafı URL'i (yoksa null → metin akışı). */
  imageUrl: string | null
  createdAt: number
}

export interface ForumReply {
  id: string
  postId: string
  userId: string
  username: string
  /** Profilde belirlenen görünen isim (yoksa kullanıcı adıyla aynı). */
  displayName: string
  content: string
  likeCount: number
  likedByMe: boolean
  /** Rozet seviyesi: super → sarı tik, admin → mavi tik, none → rozetsiz. */
  verifiedTier: VerifiedTier
  /** Profil fotoğrafı URL'i (yoksa null → baş harf gösterilir). */
  avatarUrl: string | null
  /** İsim altında görünen özel etiket (yoksa null). */
  userTag: string | null
  /** Yanıt fotoğrafı URL'i (yoksa null). */
  imageUrl: string | null
  createdAt: number
}

interface LocalStoredReply {
  id: string
  userId: string
  username: string
  content: string
  likedBy: string[]
  userTag: string | null
  imageUrl: string | null
  createdAt: number
}

interface LocalStoredPost {
  id: string
  userId: string
  username: string
  content: string
  likedBy: string[]
  replies: LocalStoredReply[]
  userTag: string | null
  imageUrl: string | null
  createdAt: number
}

export function formatTimeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return 'az önce'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}d`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}sa`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}g`
  return new Date(at).toLocaleDateString('tr-TR')
}

/**
 * Beğeni/yanıt sayacı kısaltması: 1000+ → B, 1M+ → M (tr-TR ondalık).
 * 15000 → "15B", 15500 → "15,5B", 1700000 → "1,7M", 950 → "950".
 * Sıfır/negatif/geçersiz → '' (butonlarda sayı gizlenir).
 */
export function formatLikeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${v.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}M`
  }
  if (n >= 1000) {
    const v = n / 1000
    return `${v.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}B`
  }
  return Math.floor(n).toLocaleString('tr-TR')
}

function validateContent(raw: string): string {
  const content = raw.trim()
  if (!content) throw new Error('Gönderi boş olamaz.')
  if (content.length > FORUM_POST_MAX_LENGTH) {
    throw new Error(`Gönderi en fazla ${FORUM_POST_MAX_LENGTH} karakter olmalı.`)
  }
  return content
}

function requireSessionUser() {
  const user = getSessionUser()
  if (!user) throw new Error('Gönderi paylaşmak için giriş yapmalısın.')
  return user
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Yerel mod rozet kuralı: sistem hesabı `DenizTradeX` her zaman onaylı.
 * Uzak modda rozet sunucudan gelir (`is_verified` + tetikleyici) — istemci
 * burada karar vermez, yalnızca taşır.
 */
export function isVerifiedUsername(username: string): boolean {
  return username.trim().toLowerCase() === 'deniztradex'
}

/**
 * Bot personaları (4 bot): Elon Musk, Entes Yöneticisi, İlham/İhsan Memiş,
 * Kripto Kaplanı. Forumda default insan silüeti + mavi tik (admin rozeti)
 * ile görünürler — uzak modda `post_bot_message` bunu basar, yerel
 * modda aşağıdaki kural taşır. ('faik erdem' eski yazıların rozeti için
 * korunur.)
 */
export const BOT_USERNAMES = [
  'elon musk',
  'entes yöneticisi',
  'faik erdem',
  'ilham memiş',
  'ihsan memiş',
  'kripto kaplanı',
] as const

/**
 * Bot adı normalizasyonu: JS `toLowerCase()` dotted büyük `İ`'yi `i̇`
 * (i + birleşen nokta) yapar, düz `i` ile eşleşmez. Önce `İ→i` eşlenip
 * kalan birleşen noktalar silinir — "İlham"/"ilham"/"ILHAM" hep tutar.
 */
function normalizeBotName(username: string): string {
  return username.trim().replace(/İ/g, 'i').toLowerCase().replace(/̇/g, '')
}

/** Bot hesabı mı? (mavi tik + default avatar) */
export function isBotUsername(username: string): boolean {
  return (BOT_USERNAMES as readonly string[]).includes(normalizeBotName(username))
}

// ---------------------------------------------------------------
// Yerel (çevrimdışı/test) arka uç
// ---------------------------------------------------------------

function readLocalPosts(): LocalStoredPost[] {
  try {
    const raw = localStorage.getItem(FORUM_LOCAL_KEY)
    if (!raw) return ensureLocalSeed()
    const parsed = JSON.parse(raw) as LocalStoredPost[]
    if (!Array.isArray(parsed)) return []
    // Eski sürümde yazılmış kayıtlar `replies`/`likedBy` içermeyebilir —
    // normalize edilmezse `.length` erişimi patlayıp akışı kilitler.
    return parsed.map(normalizeLocalPost)
  } catch {
    return []
  }
}

/** Eski formatlı yerel kayıtları güncel şemaya taşır (kayıpsız). */
function normalizeLocalPost(row: Partial<LocalStoredPost> & { id?: unknown }): LocalStoredPost {
  const r = row as Record<string, unknown>
  const str = (v: unknown, fb: string): string => (typeof v === 'string' && v ? v : fb)
  const strOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    id: str(r.id, makeId('post')),
    userId: str(r.userId, ''),
    username: str(r.username, 'anon'),
    content: str(r.content, ''),
    likedBy: strArray(r.likedBy),
    replies: Array.isArray(r.replies)
      ? (r.replies as Partial<LocalStoredReply>[]).map((x) => ({
          id: str(x?.id, makeId('reply')),
          userId: str(x?.userId, ''),
          username: str(x?.username, 'anon'),
          content: str(x?.content, ''),
          likedBy: strArray(x?.likedBy),
          userTag: strOrNull(x?.userTag),
          imageUrl: strOrNull(x?.imageUrl),
          createdAt: typeof x?.createdAt === 'number' ? x.createdAt : Date.now(),
        }))
      : [],
    userTag: strOrNull(r.userTag),
    imageUrl: strOrNull(r.imageUrl),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  }
}

function writeLocalPosts(posts: LocalStoredPost[]): void {
  try {
    localStorage.setItem(FORUM_LOCAL_KEY, JSON.stringify(posts))
  } catch {
    // kota/gizli mod — bellek dışı kalıcılık yok, akış yine çalışır
  }
}

/** İlk açılışta resmi karşılama gönderisi (yalnızca yerel modda). */
function ensureLocalSeed(): LocalStoredPost[] {
  const seed: LocalStoredPost[] = [
    {
      id: 'seed_welcome',
      userId: 'deniztradex',
      username: 'DenizTradeX',
      content: 'Topluluğa hoş geldin! 🎉 Piyasa görüşlerini buradan paylaşabilirsin.',
      likedBy: [],
      replies: [],
      userTag: 'Resmi Hesap',
      imageUrl: null,
      createdAt: Date.now(),
    },
  ]
  writeLocalPosts(seed)
  return seed
}

/** Yerel mod rozet kararı: sistem → super (sarı), bot → admin (mavi). */
function localVerifiedTier(username: string, rawUsername: string): VerifiedTier {
  if (isVerifiedUsername(username) || isVerifiedUsername(rawUsername)) return 'super'
  if (isBotUsername(username) || isBotUsername(rawUsername)) return 'admin'
  return 'none'
}

function toForumPost(row: LocalStoredPost, myId: string | null): ForumPost {
  const username = forumDisplayName(row.username, row.userId)
  return {
    id: row.id,
    userId: row.userId,
    username,
    displayName: username,
    content: row.content,
    likeCount: row.likedBy.length,
    likedByMe: myId !== null && row.likedBy.includes(myId),
    replyCount: row.replies.length,
    verifiedTier: localVerifiedTier(username, row.username),
    // Profil fotoğrafı yok → default insan silüeti gösterilir.
    avatarUrl: null,
    userTag: row.userTag,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt,
  }
}

function toForumReply(postId: string, row: LocalStoredReply, myId: string | null = null): ForumReply {
  const username = forumDisplayName(row.username, row.userId)
  const me = myId ?? getSessionUser()?.id ?? null
  return {
    id: row.id,
    postId,
    userId: row.userId,
    username,
    displayName: username,
    content: row.content,
    likeCount: row.likedBy.length,
    likedByMe: me !== null && row.likedBy.includes(me),
    verifiedTier: localVerifiedTier(username, row.username),
    avatarUrl: null,
    userTag: row.userTag,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt,
  }
}

/** Uzak satırdan güvenli metin/URL okuma (kolon yoksa null — eski DB uyumluluğu). */
function optText(row: Record<string, unknown>, key: string): string | null {
  const v = row[key]
  return typeof v === 'string' && v.trim() ? v : null
}

// ---------------------------------------------------------------
// Açık API — uzak modda SADECE Supabase (hata fırlatılır, yerele
// düşülmez). Yerel mod yalnızca Supabase yokken (test/çevrimdışı).
// ---------------------------------------------------------------

function listLocal(): Promise<ForumPost[]> {
  const myId = getSessionUser()?.id ?? null
  return Promise.resolve(
    readLocalPosts()
      .map((p) => toForumPost(p, myId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, FORUM_FEED_LIMIT),
  )
}

export async function listForumPosts(): Promise<ForumPost[]> {
  if (isRemoteMode()) {
    // Uzak hata gizlenmez: listeleyemezsek boş yerel akış gösterip
    // "tüm mesajlar silinmez" izlenimi vermek yerine hata fırlatılır.
    return listRemote()
  }
  return listLocal()
}

/**
 * Profil sayfası akışı: bir kullanıcının gönderileri (yeni → eski, 50).
 * Uzakta kullanıcı adına göre filtreli sorgu; yerelde aynı filtre.
 */
export async function listForumPostsByAuthor(username: string): Promise<ForumPost[]> {
  const needle = username.trim()
  if (!needle) return []
  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      const myId = getSessionUser()?.id ?? null
      const { data, error } = await supabase
        .from('forum_posts')
        .select('*')
        .ilike('username', needle)
        .order('created_at', { ascending: false })
        .limit(FORUM_FEED_LIMIT)
      if (error) throw error
      if (!Array.isArray(data)) throw new Error('unexpected-feed-shape')
      let liked = new Set<string>()
      if (myId && data.length > 0) {
        const ids = (data as { id: string }[]).map((r) => r.id)
        const { data: likes } = await supabase
          .from('forum_likes')
          .select('post_id')
          .eq('user_id', myId)
          .in('post_id', ids)
        if (Array.isArray(likes)) {
          liked = new Set((likes as { post_id: string }[]).map((l) => l.post_id))
        }
      }
      return (data as Record<string, unknown>[]).map((r) => ({
        id: String(r.id ?? ''),
        userId: String(r.user_id ?? ''),
        username: forumDisplayName(String(r.username ?? ''), String(r.user_id ?? '')),
      displayName: displayNameOf(r, forumDisplayName(String(r.username ?? ''), String(r.user_id ?? ''))),
        content: String(r.content ?? ''),
        likeCount: typeof r.like_count === 'number' ? r.like_count : 0,
        likedByMe: liked.has(String(r.id ?? '')),
        replyCount: typeof r.reply_count === 'number' ? r.reply_count : 0,
        verifiedTier: parseVerifiedTier(r.verified_tier),
        avatarUrl: optText(r, 'avatar_url'),
        userTag: optText(r, 'user_tag'),
        imageUrl: optText(r, 'image_url'),
        createdAt: Date.parse(String(r.created_at ?? '')) || Date.now(),
      }))
    } catch (err) {
      throw classifyForumRemoteError(err, 'Profil gönderileri yüklenemedi')
    }
  }
  const myId = getSessionUser()?.id ?? null
  return Promise.resolve(
    readLocalPosts()
      .filter((p) => p.username.toLowerCase() === needle.toLowerCase())
      .map((p) => toForumPost(p, myId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, FORUM_FEED_LIMIT),
  )
}

async function listRemote(): Promise<ForumPost[]> {
  if (!supabase) throw new Error('no-backend')
  try {
    const myId = getSessionUser()?.id ?? null
    // `select('*')` bilerek: user_tag/image_url migration'ı uygulanmamış
    // eski DB'lerde açık kolon listesi sorguyu patlatırdı; yıldızla
    // gelen satır toleranslı eşlenir, akış kırılmaz.
    const { data, error } = await supabase
        .from('forum_posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(FORUM_FEED_LIMIT)
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('unexpected-feed-shape')
    let liked = new Set<string>()
    if (myId && data.length > 0) {
      const ids = (data as { id: string }[]).map((r) => r.id)
      const { data: likes } = await supabase
        .from('forum_likes')
        .select('post_id')
        .eq('user_id', myId)
        .in('post_id', ids)
      if (Array.isArray(likes)) {
        liked = new Set((likes as { post_id: string }[]).map((l) => l.post_id))
      }
    }
    return (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id ?? ''),
      userId: String(r.user_id ?? ''),
      username: forumDisplayName(String(r.username ?? ''), String(r.user_id ?? '')),
      displayName: displayNameOf(r, forumDisplayName(String(r.username ?? ''), String(r.user_id ?? ''))),
      content: String(r.content ?? ''),
      likeCount: typeof r.like_count === 'number' ? r.like_count : 0,
      likedByMe: liked.has(String(r.id ?? '')),
      replyCount: typeof r.reply_count === 'number' ? r.reply_count : 0,
      verifiedTier: parseVerifiedTier(r.verified_tier),
      avatarUrl: optText(r, 'avatar_url'),
      userTag: optText(r, 'user_tag'),
      imageUrl: optText(r, 'image_url'),
      createdAt: Date.parse(String(r.created_at ?? '')) || Date.now(),
    }))
  } catch (err) {
    throw classifyForumRemoteError(err, 'Akış yüklenemedi')
  }
}

function createLocal(
  user: { id: string; username: string; userTag?: string | null },
  content: string,
  imageUrl?: string | null,
): Promise<ForumPost> {
  const post: LocalStoredPost = {
    id: makeId('post'),
    userId: user.id,
    username: user.username,
    content,
    likedBy: [],
    replies: [],
    userTag: user.userTag?.trim() ? user.userTag.trim().slice(0, 24) : null,
    imageUrl: imageUrl?.trim() ? imageUrl : null,
    createdAt: Date.now(),
  }
  writeLocalPosts([post, ...readLocalPosts()])
  return Promise.resolve(toForumPost(post, user.id))
}

export async function createForumPost(
  rawContent: string,
  opts?: { imageUrl?: string | null },
): Promise<ForumPost> {
  const content = validateContent(rawContent)
  const user = requireSessionUser()
  const imageUrl = opts?.imageUrl?.trim() ? opts.imageUrl.trim() : null

  if (isRemoteMode()) {
    // Uzak yazım başarısızsa yerele yazıp "paylaşıldı" demek, gönderinin
    // yalnızca bu cihazda görünüp diğerinde görünmemesine (ve sonra
    // "silinmiş" sanılmasına) yol açardı. Hata aynen iletilir.
    return createRemote(user, content, imageUrl)
  }
  return createLocal(user, content, imageUrl)
}

async function createRemote(
  user: { id: string; username: string; email?: string; userTag?: string | null },
  content: string,
  imageUrl: string | null,
): Promise<ForumPost> {
  if (!supabase) throw new Error('no-backend')
  const username = resolveWriteUsername(user)
  const userTag = user.userTag?.trim() ? user.userTag.trim().slice(0, 24) : null
  const mapRow = (row: Record<string, unknown>): ForumPost => ({
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    username: forumDisplayName(String(row.username ?? ''), String(row.user_id ?? '')),
    displayName: displayNameOf(row, forumDisplayName(String(row.username ?? ''), String(row.user_id ?? ''))),
    content: String(row.content ?? ''),
    likeCount: typeof row.like_count === 'number' ? row.like_count : 0,
    likedByMe: false,
    replyCount: typeof row.reply_count === 'number' ? row.reply_count : 0,
    verifiedTier: parseVerifiedTier(row.verified_tier),
    avatarUrl: optText(row, 'avatar_url'),
    userTag: optText(row, 'user_tag') ?? userTag,
    imageUrl: optText(row, 'image_url') ?? imageUrl,
    createdAt: Date.parse(String(row.created_at ?? '')) || Date.now(),
  })
  try {
    const { data, error } = await supabase
        .from('forum_posts')
        .insert({ user_id: user.id, username, content, user_tag: userTag, image_url: imageUrl })
        .select('*')
        .single()
      if (error) throw error
      if (!data) throw new Error('unexpected-create-shape')
      return mapRow(data as Record<string, unknown>)
  } catch (err) {
    // Eski DB (kolonlar yok): yalın gövdeyle tekrar dene, akış kırılmaz.
    if (isMissingColumnError(err)) {
      try {
        const { data, error } = await supabase
          .from('forum_posts')
          .insert({ user_id: user.id, username, content })
          .select('*')
          .single()
        if (error) throw error
        if (!data) throw new Error('unexpected-create-shape')
        return mapRow(data as Record<string, unknown>)
      } catch (retryErr) {
        throw classifyForumRemoteError(retryErr, 'Gönderi paylaşılamadı')
      }
    }
    throw classifyForumRemoteError(err, 'Gönderi paylaşılamadı')
  }
}

/** PostgREST "kolon yok" hatası mı? (migration uygulanmamış eski DB) */
function isMissingColumnError(err: unknown): boolean {
  const raw = (err ?? {}) as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown }
  const code = String(raw.code ?? '').toUpperCase()
  const text = `${String(raw.message ?? '')} ${String(raw.details ?? '')} ${String(raw.hint ?? '')}`.toLowerCase()
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    text.includes('user_tag') ||
    text.includes('image_url') ||
    (text.includes('column') && text.includes('does not exist'))
  )
}

/**
 * Bot personası adına forum gönderisi (Bot Simülasyon Motoru).
 * Uzak modda `post_bot_message` RPC'si (süper admin zorunlu), yerel
 * modda sahte beğenili doğrudan kayıt. Oturumdaki admin değişmez —
 * akış anında güncellenir (realtime/polling).
 */
export async function createBotForumPost(
  username: string,
  rawContent: string,
  fakeLikes = 0,
): Promise<ForumPost> {
  const content = validateContent(rawContent)
  const name = username.trim()
  if (!name) throw new Error('Geçersiz bot adı.')
  const likes = Math.max(0, Math.floor(fakeLikes))

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      const { data: newId, error: rpcError } = await supabase.rpc('post_bot_message', {
        p_username: name,
        p_content: content,
        p_fake_likes: likes,
      })
      if (rpcError) throw rpcError
      if (typeof newId !== 'string' || !newId) throw new Error('unexpected-create-shape')
      const { data, error } = await supabase
        .from('forum_posts')
        .select('*')
        .eq('id', newId)
        .maybeSingle()
      if (error || !data) throw error ?? new Error('unexpected-create-shape')
      const row = data as Record<string, unknown>
      return {
        id: String(row.id ?? ''),
        userId: String(row.user_id ?? ''),
        username: forumDisplayName(String(row.username ?? ''), String(row.user_id ?? '')),
      displayName: displayNameOf(row, forumDisplayName(String(row.username ?? ''), String(row.user_id ?? ''))),
        content: String(row.content ?? ''),
        likeCount: typeof row.like_count === 'number' ? row.like_count : 0,
        likedByMe: false,
        replyCount: typeof row.reply_count === 'number' ? row.reply_count : 0,
        verifiedTier: parseVerifiedTier(row.verified_tier),
        avatarUrl: optText(row, 'avatar_url'),
        userTag: optText(row, 'user_tag'),
        imageUrl: optText(row, 'image_url'),
        createdAt: Date.parse(String(row.created_at ?? '')) || Date.now(),
      }
    } catch (err) {
      throw classifyForumRemoteError(err, 'Bot mesajı gönderilemedi')
    }
  }

  const post: LocalStoredPost = {
    id: makeId('post'),
    userId: `bot_${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    username: name,
    content,
    likedBy: Array.from({ length: likes }, (_, i) => `botfan_${i}`),
    replies: [],
    userTag: null,
    imageUrl: null,
    createdAt: Date.now(),
  }
  writeLocalPosts([post, ...readLocalPosts()])
  return toForumPost(post, getSessionUser()?.id ?? null)
}

function toggleLocal(
  user: { id: string },
  postId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) throw new Error('Gönderi bulunamadı.')
  const idx = post.likedBy.indexOf(user.id)
  const liked = idx === -1
  post.likedBy = liked
    ? [...post.likedBy, user.id]
    : post.likedBy.filter((id) => id !== user.id)
  writeLocalPosts(posts)
  return Promise.resolve({ liked, likeCount: post.likedBy.length })
}

export async function toggleForumLike(
  postId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const user = requireSessionUser()

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      const { data, error } = await supabase.rpc('toggle_forum_like', {
        p_post_id: postId,
      })
      if (error) throw error
      if (!data) throw new Error('unexpected-like-shape')
      const res = data as { liked?: boolean; like_count?: number }
      return { liked: res.liked === true, likeCount: res.like_count ?? 0 }
    } catch (err) {
      throw classifyForumRemoteError(err, 'Beğeni işlenemedi')
    }
  }
  return toggleLocal(user, postId)
}

function deleteLocal(user: { id: string }, postId: string): Promise<void> {
  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) return Promise.resolve()
  if (post.userId !== user.id) return Promise.reject(new Error('Yalnızca kendi gönderini silebilirsin.'))
  writeLocalPosts(posts.filter((p) => p.id !== postId))
  return Promise.resolve()
}

export async function deleteForumPost(postId: string): Promise<void> {
  const user = requireSessionUser()

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      // RLS reddederse (başkasının gönderisi) PostgREST satır döndürmez;
      // sessizce "silinmiş" gibi davranmak yerine doğrula.
      const { data, error } = await supabase
        .from('forum_posts')
        .delete()
        .eq('id', postId)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        // Satır yoksa: ya zaten silinmiş ya da yetkisiz. Yerel bir şeyi
        // silmiyoruz — uzak durum korunur, akış tutarlı kalır.
        throw new Error('Gönderi silinemedi. Yalnızca kendi gönderini silebilirsin.')
      }
      return
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Gönderi silinemedi. Yalnızca')) throw err
      throw classifyForumRemoteError(err, 'Gönderi silinemedi')
    }
  }
  return deleteLocal(user, postId)
}

// ---------------------------------------------------------------
// Yanıtlar
// ---------------------------------------------------------------

function validateReply(raw: string): string {
  const content = raw.trim()
  if (!content) throw new Error('Yanıt boş olamaz.')
  if (content.length > FORUM_POST_MAX_LENGTH) {
    throw new Error(`Yanıt en fazla ${FORUM_POST_MAX_LENGTH} karakter olmalı.`)
  }
  return content
}

export async function listForumReplies(postId: string): Promise<ForumReply[]> {
  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      const { data, error } = await supabase
        .from('forum_replies')
        .select('*')
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
        .limit(100)
      if (error) throw error
      if (!Array.isArray(data)) throw new Error('unexpected-replies-shape')
      const rows = data as Record<string, unknown>[]
      // Beğenilerim (uzak): bu yanıtlar içindeki kendi beğenilerim.
      let liked = new Set<string>()
      {
        const myId = getSessionUser()?.id ?? null
        if (myId && rows.length > 0) {
          const ids = rows.map((r) => String(r.id ?? '')).filter(Boolean)
          const { data: likes } = await supabase
            .from('forum_reply_likes')
            .select('reply_id')
            .eq('user_id', myId)
            .in('reply_id', ids)
          if (Array.isArray(likes)) {
            liked = new Set((likes as { reply_id: string }[]).map((l) => l.reply_id))
          }
        }
      }
      return rows.map((r) => ({
        id: String(r.id ?? ''),
        postId: String(r.post_id ?? postId),
        userId: String(r.user_id ?? ''),
        username: forumDisplayName(String(r.username ?? ''), String(r.user_id ?? '')),
      displayName: displayNameOf(r, forumDisplayName(String(r.username ?? ''), String(r.user_id ?? ''))),
        content: String(r.content ?? ''),
        likeCount: typeof r.like_count === 'number' ? r.like_count : 0,
        likedByMe: liked.has(String(r.id ?? '')),
        verifiedTier: parseVerifiedTier(r.verified_tier),
        avatarUrl: optText(r, 'avatar_url'),
        userTag: optText(r, 'user_tag'),
        imageUrl: optText(r, 'image_url'),
        createdAt: Date.parse(String(r.created_at ?? '')) || Date.now(),
      }))
    } catch (err) {
      throw classifyForumRemoteError(err, 'Yanıtlar yüklenemedi')
    }
  }
  const post = readLocalPosts().find((p) => p.id === postId)
  if (!post) return []
  return [...post.replies]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => toForumReply(postId, r))
}

export async function createForumReply(
  postId: string,
  rawContent: string,
  opts?: { imageUrl?: string | null },
): Promise<ForumReply> {
  const content = validateReply(rawContent)
  const user = requireSessionUser()
  const imageUrl = opts?.imageUrl?.trim() ? opts.imageUrl.trim() : null

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    const username = resolveWriteUsername(user)
    const userTag = user.userTag?.trim() ? user.userTag.trim().slice(0, 24) : null
    const mapRow = (row: Record<string, unknown>): ForumReply => ({
      id: String(row.id ?? ''),
      postId: String(row.post_id ?? postId),
      userId: String(row.user_id ?? ''),
      username: forumDisplayName(String(row.username ?? ''), String(row.user_id ?? '')),
      displayName: displayNameOf(row, forumDisplayName(String(row.username ?? ''), String(row.user_id ?? ''))),
      content: String(row.content ?? ''),
      likeCount: typeof row.like_count === 'number' ? row.like_count : 0,
      likedByMe: false,
      verifiedTier: parseVerifiedTier(row.verified_tier),
      avatarUrl: optText(row, 'avatar_url'),
      userTag: optText(row, 'user_tag') ?? userTag,
      imageUrl: optText(row, 'image_url') ?? imageUrl,
      createdAt: Date.parse(String(row.created_at ?? '')) || Date.now(),
    })
    try {
      const { data, error } = await supabase
        .from('forum_replies')
        .insert({ post_id: postId, user_id: user.id, username, content, user_tag: userTag, image_url: imageUrl })
        .select('*')
        .single()
      if (error) throw error
      if (!data) throw new Error('unexpected-reply-shape')
      return mapRow(data as Record<string, unknown>)
    } catch (err) {
      if (isMissingColumnError(err)) {
        try {
          const { data, error } = await supabase
            .from('forum_replies')
            .insert({ post_id: postId, user_id: user.id, username, content })
            .select('*')
            .single()
          if (error) throw error
          if (!data) throw new Error('unexpected-reply-shape')
          return mapRow(data as Record<string, unknown>)
        } catch (retryErr) {
          throw classifyForumRemoteError(retryErr, 'Yanıt gönderilemedi')
        }
      }
      throw classifyForumRemoteError(err, 'Yanıt gönderilemedi')
    }
  }

  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) throw new Error('Gönderi bulunamadı.')
  const reply: LocalStoredReply = {
    id: makeId('reply'),
    userId: user.id,
    username: user.username,
    content,
    likedBy: [],
    userTag: user.userTag?.trim() ? user.userTag.trim().slice(0, 24) : null,
    imageUrl,
    createdAt: Date.now(),
  }
  post.replies = [...post.replies, reply]
  writeLocalPosts(posts)
  return toForumReply(postId, reply)
}

export async function deleteForumReply(postId: string, replyId: string): Promise<void> {  const user = requireSessionUser()

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      const { data, error } = await supabase
        .from('forum_replies')
        .delete()
        .eq('id', replyId)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('Yanıt silinemedi. Yalnızca kendi yanıtını silebilirsin.')
      }
      return
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Yanıt silinemedi. Yalnızca')) throw err
      throw classifyForumRemoteError(err, 'Yanıt silinemedi')
    }
  }

  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) return
  const reply = post.replies.find((r) => r.id === replyId)
  if (!reply) return
  if (reply.userId !== user.id) throw new Error('Yalnızca kendi yanıtını silebilirsin.')
  post.replies = post.replies.filter((r) => r.id !== replyId)
  writeLocalPosts(posts)
}

/**
 * Yanıt beğen/geri-al (gönderi beğenisiyle aynı desen).
 * Uzak modda `toggle_forum_reply_like` RPC'si; migration uygulanmamış
 * eski DB'de açık hata fırlatılır (sessiz yerel beğeni akışı
 * bölerdi — cihazlar arası tutarlılık korunur).
 */
export async function toggleForumReplyLike(
  postId: string,
  replyId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const user = requireSessionUser()

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    try {
      const { data, error } = await supabase.rpc('toggle_forum_reply_like', {
        p_reply_id: replyId,
      })
      if (error) throw error
      if (!data) throw new Error('unexpected-like-shape')
      const res = data as { liked?: boolean; like_count?: number }
      return { liked: res.liked === true, likeCount: res.like_count ?? 0 }
    } catch (err) {
      if ((err as { code?: string })?.code === 'PGRST202') {
        throw new Error(
          "Yanıt beğenme altyapısı veritabanında yok. Yönetici Supabase SQL Editor'de 20260918110000_forum_reply_likes migration'ını uygulamalı.",
        )
      }
      throw classifyForumRemoteError(err, 'Beğeni işlenemedi')
    }
  }

  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) throw new Error('Gönderi bulunamadı.')
  const reply = post.replies.find((r) => r.id === replyId)
  if (!reply) throw new Error('Yanıt bulunamadı.')
  const idx = reply.likedBy.indexOf(user.id)
  const liked = idx === -1
  reply.likedBy = liked
    ? [...reply.likedBy, user.id]
    : reply.likedBy.filter((id) => id !== user.id)
  writeLocalPosts(posts)
  return { liked, likeCount: reply.likedBy.length }
}
