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

export const FORUM_POST_MAX_LENGTH = 500
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

export interface ForumPost {
  id: string
  userId: string
  username: string
  content: string
  likeCount: number
  likedByMe: boolean
  replyCount: number
  /** Rozet seviyesi: super → sarı tik, admin → mavi tik, none → rozetsiz. */
  verifiedTier: VerifiedTier
  /** Profil fotoğrafı URL'i (yoksa null → baş harf gösterilir). */
  avatarUrl: string | null
  createdAt: number
}

export interface ForumReply {
  id: string
  postId: string
  userId: string
  username: string
  content: string
  /** Rozet seviyesi: super → sarı tik, admin → mavi tik, none → rozetsiz. */
  verifiedTier: VerifiedTier
  /** Profil fotoğrafı URL'i (yoksa null → baş harf gösterilir). */
  avatarUrl: string | null
  createdAt: number
}

interface LocalStoredReply {
  id: string
  userId: string
  username: string
  content: string
  createdAt: number
}

interface LocalStoredPost {
  id: string
  userId: string
  username: string
  content: string
  likedBy: string[]
  replies: LocalStoredReply[]
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
 * Bot personaları (4 bot): Elon Musk, Faik Erdem, İlham/İhsan Memiş,
 * Kripto Kaplanı. Forumda default insan silüeti + mavi tik (admin rozeti)
 * ile görünürler — uzak modda `post_bot_message` bunu basar, yerel
 * modda aşağıdaki kural taşır.
 */
export const BOT_USERNAMES = [
  'elon musk',
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
          createdAt: typeof x?.createdAt === 'number' ? x.createdAt : Date.now(),
        }))
      : [],
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
    content: row.content,
    likeCount: row.likedBy.length,
    likedByMe: myId !== null && row.likedBy.includes(myId),
    replyCount: row.replies.length,
    verifiedTier: localVerifiedTier(username, row.username),
    // Profil fotoğrafı yok → default insan silüeti gösterilir.
    avatarUrl: null,
    createdAt: row.createdAt,
  }
}

function toForumReply(postId: string, row: LocalStoredReply): ForumReply {
  const username = forumDisplayName(row.username, row.userId)
  return {
    id: row.id,
    postId,
    userId: row.userId,
    username,
    content: row.content,
    verifiedTier: localVerifiedTier(username, row.username),
    avatarUrl: null,
    createdAt: row.createdAt,
  }
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
    // "tüm mesajlar silindi" izlenimi vermek yerine hata fırlatılır.
    return listRemote()
  }
  return listLocal()
}

async function listRemote(): Promise<ForumPost[]> {
  if (!supabase) throw new Error('no-backend')
  try {
    const myId = getSessionUser()?.id ?? null
    const { data, error } = await supabase
        .from('forum_posts')
        .select('id,user_id,username,content,like_count,reply_count,verified_tier,avatar_url,created_at')
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
    return (data as {
      id: string
      user_id: string
      username: string
      content: string
      like_count: number
      reply_count: number
      verified_tier: unknown
      avatar_url: unknown
      created_at: string
    }[]).map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: forumDisplayName(r.username, r.user_id),
      content: r.content,
      likeCount: r.like_count ?? 0,
      likedByMe: liked.has(r.id),
      replyCount: r.reply_count ?? 0,
      verifiedTier: parseVerifiedTier(r.verified_tier),
      avatarUrl: typeof r.avatar_url === 'string' && r.avatar_url ? r.avatar_url : null,
      createdAt: Date.parse(r.created_at) || Date.now(),
    }))
  } catch (err) {
    throw classifyForumRemoteError(err, 'Akış yüklenemedi')
  }
}

function createLocal(user: { id: string; username: string }, content: string): Promise<ForumPost> {
  const post: LocalStoredPost = {
    id: makeId('post'),
    userId: user.id,
    username: user.username,
    content,
    likedBy: [],
    replies: [],
    createdAt: Date.now(),
  }
  writeLocalPosts([post, ...readLocalPosts()])
  return Promise.resolve(toForumPost(post, user.id))
}

export async function createForumPost(rawContent: string): Promise<ForumPost> {
  const content = validateContent(rawContent)
  const user = requireSessionUser()

  if (isRemoteMode()) {
    // Uzak yazım başarısızsa yerele yazıp "paylaşıldı" demek, gönderinin
    // yalnızca bu cihazda görünüp diğerinde görünmemesine (ve sonra
    // "silinmiş" sanılmasına) yol açardı. Hata aynen iletilir.
    return createRemote(user, content)
  }
  return createLocal(user, content)
}

async function createRemote(
  user: { id: string; username: string; email?: string },
  content: string,
): Promise<ForumPost> {
  if (!supabase) throw new Error('no-backend')
  const username = resolveWriteUsername(user)
  try {
    const { data, error } = await supabase
        .from('forum_posts')
        .insert({ user_id: user.id, username, content })
        .select('id,user_id,username,content,like_count,reply_count,verified_tier,avatar_url,created_at')
        .single()
      if (error) throw error
      if (!data) throw new Error('unexpected-create-shape')
      const row = data as {
        id: string
        user_id: string
        username: string
        content: string
        like_count: number
        reply_count: number
        verified_tier: unknown
      avatar_url: unknown
        created_at: string
      }
      return {
        id: row.id,
        userId: row.user_id,
        username: forumDisplayName(row.username, row.user_id),
        content: row.content,
        likeCount: row.like_count ?? 0,
        likedByMe: false,
        replyCount: row.reply_count ?? 0,
        verifiedTier: parseVerifiedTier(row.verified_tier),
        avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url ? row.avatar_url : null,
        createdAt: Date.parse(row.created_at) || Date.now(),
      }
  } catch (err) {
    throw classifyForumRemoteError(err, 'Gönderi paylaşılamadı')
  }
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
        .select('id,user_id,username,content,like_count,reply_count,verified_tier,avatar_url,created_at')
        .eq('id', newId)
        .maybeSingle()
      if (error || !data) throw error ?? new Error('unexpected-create-shape')
      const row = data as {
        id: string
        user_id: string
        username: string
        content: string
        like_count: number
        reply_count: number
        verified_tier: unknown
        avatar_url: unknown
        created_at: string
      }
      return {
        id: row.id,
        userId: row.user_id,
        username: forumDisplayName(row.username, row.user_id),
        content: row.content,
        likeCount: row.like_count ?? 0,
        likedByMe: false,
        replyCount: row.reply_count ?? 0,
        verifiedTier: parseVerifiedTier(row.verified_tier),
        avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url ? row.avatar_url : null,
        createdAt: Date.parse(row.created_at) || Date.now(),
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
        .select('id,post_id,user_id,username,content,verified_tier,avatar_url,created_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
        .limit(100)
      if (error) throw error
      if (!Array.isArray(data)) throw new Error('unexpected-replies-shape')
      return (data as {
        id: string
        post_id: string
        user_id: string
        username: string
        content: string
        verified_tier: unknown
      avatar_url: unknown
        created_at: string
      }[]).map((r) => ({
        id: r.id,
        postId: r.post_id,
        userId: r.user_id,
        username: forumDisplayName(r.username, r.user_id),
        content: r.content,
        verifiedTier: parseVerifiedTier(r.verified_tier),
      avatarUrl: typeof r.avatar_url === 'string' && r.avatar_url ? r.avatar_url : null,
        createdAt: Date.parse(r.created_at) || Date.now(),
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

export async function createForumReply(postId: string, rawContent: string): Promise<ForumReply> {
  const content = validateReply(rawContent)
  const user = requireSessionUser()

  if (isRemoteMode()) {
    if (!supabase) throw new Error('no-backend')
    const username = resolveWriteUsername(user)
    try {
      const { data, error } = await supabase
        .from('forum_replies')
        .insert({ post_id: postId, user_id: user.id, username, content })
        .select('id,post_id,user_id,username,content,verified_tier,avatar_url,created_at')
        .single()
      if (error) throw error
      if (!data) throw new Error('unexpected-reply-shape')
      const row = data as {
        id: string
        post_id: string
        user_id: string
        username: string
        content: string
        verified_tier: unknown
      avatar_url: unknown
        created_at: string
      }
      return {
        id: row.id,
        postId: row.post_id,
        userId: row.user_id,
        username: forumDisplayName(row.username, row.user_id),
        content: row.content,
        verifiedTier: parseVerifiedTier(row.verified_tier),
        avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url ? row.avatar_url : null,
        createdAt: Date.parse(row.created_at) || Date.now(),
      }
    } catch (err) {
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
    createdAt: Date.now(),
  }
  post.replies = [...post.replies, reply]
  writeLocalPosts(posts)
  return toForumReply(postId, reply)
}

export async function deleteForumReply(postId: string, replyId: string): Promise<void> {
  const user = requireSessionUser()

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
