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
  createdAt: number
}

interface LocalStoredPost {
  id: string
  userId: string
  username: string
  content: string
  likedBy: string[]
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
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------
// Açık API
// ---------------------------------------------------------------

export async function listForumPosts(): Promise<ForumPost[]> {
  if (isSupabaseConfigured && supabase) {
    const myId = getSessionUser()?.id ?? null
    const { data, error } = await supabase
      .from('forum_posts')
      .select('id,user_id,username,content,like_count,created_at')
      .order('created_at', { ascending: false })
      .limit(FORUM_FEED_LIMIT)
    if (error || !Array.isArray(data)) return []
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
      created_at: string
    }[]).map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      content: r.content,
      likeCount: r.like_count ?? 0,
      likedByMe: liked.has(r.id),
      createdAt: Date.parse(r.created_at) || Date.now(),
    }))
  }

  const myId = getSessionUser()?.id ?? null
  return readLocalPosts()
    .map((p) => toForumPost(p, myId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, FORUM_FEED_LIMIT)
}

export async function createForumPost(rawContent: string): Promise<ForumPost> {
  const content = validateContent(rawContent)
  const user = requireSessionUser()

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('forum_posts')
      .insert({ user_id: user.id, username: user.username, content })
      .select('id,user_id,username,content,like_count,created_at')
      .single()
    if (error || !data) {
      throw new Error('Gönderi paylaşılamadı. Lütfen tekrar dene.')
    }
    const row = data as {
      id: string
      user_id: string
      username: string
      content: string
      like_count: number
      created_at: string
    }
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      content: row.content,
      likeCount: row.like_count ?? 0,
      likedByMe: false,
      createdAt: Date.parse(row.created_at) || Date.now(),
    }
  }

  const post: LocalStoredPost = {
    id: makeId('post'),
    userId: user.id,
    username: user.username,
    content,
    likedBy: [],
    createdAt: Date.now(),
  }
  writeLocalPosts([post, ...readLocalPosts()])
  return toForumPost(post, user.id)
}

export async function toggleForumLike(
  postId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const user = requireSessionUser()

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('toggle_forum_like', {
      p_post_id: postId,
    })
    if (error || !data) {
      throw new Error('Beğeni işlenemedi. Lütfen tekrar dene.')
    }
    const res = data as { liked?: boolean; like_count?: number }
    return { liked: res.liked === true, likeCount: res.like_count ?? 0 }
  }

  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) throw new Error('Gönderi bulunamadı.')
  const idx = post.likedBy.indexOf(user.id)
  const liked = idx === -1
  post.likedBy = liked
    ? [...post.likedBy, user.id]
    : post.likedBy.filter((id) => id !== user.id)
  writeLocalPosts(posts)
  return { liked, likeCount: post.likedBy.length }
}

export async function deleteForumPost(postId: string): Promise<void> {
  const user = requireSessionUser()

  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('forum_posts').delete().eq('id', postId)
    if (error) throw new Error('Gönderi silinemedi. Lütfen tekrar dene.')
    return
  }

  const posts = readLocalPosts()
  const post = posts.find((p) => p.id === postId)
  if (!post) return
  if (post.userId !== user.id) throw new Error('Yalnızca kendi gönderini silebilirsin.')
  writeLocalPosts(posts.filter((p) => p.id !== postId))
}
