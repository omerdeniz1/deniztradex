import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'

/**
 * Forum (Topluluk) veri katmanı — Supabase öncelikli, çevrimdışı yedekli.
 *
 * Supabase yapılandırıldığında (`forum_posts` / `forum_likes` tabloları +
 * `toggle_forum_like` RPC'si) tüm cihazlar aynı akışı görür. Yapılandırma
 * yoksa (vitest / çevrimdışı) sayfa yerel depolamayla çalışmaya devam
 * eder; testler deterministik ve ağsız kalır.
 */

export const FORUM_POST_MAX_LENGTH = 280
const FORUM_LOCAL_KEY = 'deniztradx_forum_posts_v1'
const FORUM_FEED_LIMIT = 50

export interface ForumPost {
  id: string
  userId: string
  username: string
  content: string
  likeCount: number
  likedByMe: boolean
  replyCount: number
  createdAt: number
}

export interface ForumReply {
  id: string
  postId: string
  userId: string
  username: string
  content: string
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

// ---------------------------------------------------------------
// Yerel (çevrimdışı/test) arka uç
// ---------------------------------------------------------------

function readLocalPosts(): LocalStoredPost[] {
  try {
    const raw = localStorage.getItem(FORUM_LOCAL_KEY)
    if (!raw) return ensureLocalSeed()
    const parsed = JSON.parse(raw) as LocalStoredPost[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
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

function toForumPost(row: LocalStoredPost, myId: string | null): ForumPost {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username,
    content: row.content,
    likeCount: row.likedBy.length,
    likedByMe: myId !== null && row.likedBy.includes(myId),
    replyCount: row.replies.length,
    createdAt: row.createdAt,
  }
}

function toForumReply(postId: string, row: LocalStoredReply): ForumReply {
  return {
    id: row.id,
    postId,
    userId: row.userId,
    username: row.username,
    content: row.content,
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------
// Açık API — Supabase öncelikli, hata durumunda yerel yedekli.
//
// Neden yedek? Tablolar/RPC henüz veritabanında yoksa (migration
// uygulanmamışsa) Supabase çağrısı patlar. O durumda hata fırlatıp
// sayfayı kilitlemek yerine yerel depolamaya düşülür: gönderi
// paylaşma/beğenme/silme anında çalışır. Migration uygulanınca aynı
// kod paylaşılan akışa geçer (yerel kayıtlar taşınmaz).
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
  if (isSupabaseConfigured && supabase) {
    try {
      return await listRemote()
    } catch {
      // tablo yok / ağ hatası → yerel akış
    }
  }
  return listLocal()
}

async function listRemote(): Promise<ForumPost[]> {
  if (!supabase) throw new Error('no-backend')
  const myId = getSessionUser()?.id ?? null
  const { data, error } = await supabase
      .from('forum_posts')
      .select('id,user_id,username,content,like_count,reply_count,created_at')
      .order('created_at', { ascending: false })
      .limit(FORUM_FEED_LIMIT)
  if (error || !Array.isArray(data)) throw new Error('feed-failed')
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
    created_at: string
  }[]).map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    content: r.content,
    likeCount: r.like_count ?? 0,
    likedByMe: liked.has(r.id),
    replyCount: r.reply_count ?? 0,
    createdAt: Date.parse(r.created_at) || Date.now(),
  }))
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

  if (isSupabaseConfigured && supabase) {
    try {
      return await createRemote(user, content)
    } catch {
      // tablo yok / ağ hatası → yerel paylaşım
    }
  }
  return createLocal(user, content)
}

async function createRemote(
  user: { id: string; username: string },
  content: string,
): Promise<ForumPost> {
  if (!supabase) throw new Error('no-backend')
  const { data, error } = await supabase
      .from('forum_posts')
      .insert({ user_id: user.id, username: user.username, content })
      .select('id,user_id,username,content,like_count,reply_count,created_at')
      .single()
    if (error || !data) throw new Error('paylasim-failed')
    const row = data as {
      id: string
      user_id: string
      username: string
      content: string
      like_count: number
      reply_count: number
      created_at: string
    }
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      content: row.content,
      likeCount: row.like_count ?? 0,
      likedByMe: false,
      replyCount: row.reply_count ?? 0,
      createdAt: Date.parse(row.created_at) || Date.now(),
    }
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

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.rpc('toggle_forum_like', {
        p_post_id: postId,
      })
      if (error || !data) throw new Error('begeni-failed')
      const res = data as { liked?: boolean; like_count?: number }
      return { liked: res.liked === true, likeCount: res.like_count ?? 0 }
    } catch (err) {
      // "Gönderi bulunamadı" gibi gerçek hatalar da buraya düşer — ancak
      // migration'sız DB'de her şey başarısız olacağı için yereli dene;
      // yerel de bulamazsa hatayı aynen iletir.
      try {
        return await toggleLocal(user, postId)
      } catch {
        throw err instanceof Error ? err : new Error('Beğeni işlenemedi. Lütfen tekrar dene.')
      }
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

  if (isSupabaseConfigured && supabase) {
    try {
      const { error } = await supabase.from('forum_posts').delete().eq('id', postId)
      if (error) throw error
      return
    } catch {
      // tablo yok / ağ hatası → yerel silme
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
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('forum_replies')
        .select('id,post_id,user_id,username,content,created_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
        .limit(100)
      if (error || !Array.isArray(data)) throw new Error('yanit-liste-failed')
      return (data as {
        id: string
        post_id: string
        user_id: string
        username: string
        content: string
        created_at: string
      }[]).map((r) => ({
        id: r.id,
        postId: r.post_id,
        userId: r.user_id,
        username: r.username,
        content: r.content,
        createdAt: Date.parse(r.created_at) || Date.now(),
      }))
    } catch {
      // tablo yok / ağ hatası → yerel yanıtlar
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

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('forum_replies')
        .insert({ post_id: postId, user_id: user.id, username: user.username, content })
        .select('id,post_id,user_id,username,content,created_at')
        .single()
      if (error || !data) throw new Error('yanit-failed')
      const row = data as {
        id: string
        post_id: string
        user_id: string
        username: string
        content: string
        created_at: string
      }
      return {
        id: row.id,
        postId: row.post_id,
        userId: row.user_id,
        username: row.username,
        content: row.content,
        createdAt: Date.parse(row.created_at) || Date.now(),
      }
    } catch {
      // tablo yok / ağ hatası → yerel yanıt
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

  if (isSupabaseConfigured && supabase) {
    try {
      const { error } = await supabase.from('forum_replies').delete().eq('id', replyId)
      if (error) throw error
      return
    } catch {
      // tablo yok / ağ hatası → yerel silme
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
