import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'

/**
 * Forum etiketleme (@kullanıcı) bildirimleri.
 *
 * Akış: yazı/yanıt yayınlanınca metindeki @adlar çıkarılır, her farklı ad
 * için `notify_mention` RPC'si çağrılır. Sunucu hedefi çözer, kendi kendini
 * ve bilinmeyen adları atlar, "X senden bahsetti" kaydını yazar. Tüm çağrılar
 * best-effort'tur — bildirim hatası yazı akışını asla bozmaz.
 */

export interface MentionNotification {
  id: string
  actorUsername: string
  postId: string | null
  replyId: string | null
  excerpt: string
  isRead: boolean
  createdAt: number
}

/** Bildirim başına en fazla tetiklenecek farklı kullanıcı. */
export const MAX_MENTIONS_PER_POST = 5

// Harf (Türkçe dahil) + rakam + alt çizgi, en az 3 karakter (kayıt kuralıyla
// aynı). Önünde kelime karakteri varsa e-posta sayılır, eşleşmez.
const MENTION_RE = /(^|[^A-Za-z0-9_çÇğĞıİöÖşŞüÜ])@([A-Za-z0-9_çÇğĞıİöÖşŞüÜ]{3,20})/gu

/** Metindeki @kullanıcı adları (sıralı, tekrarsız, en fazla 5). */
export function extractMentions(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(content)) !== null) {
    const name = m[2]
    const key = name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(name)
      if (out.length >= MAX_MENTIONS_PER_POST) break
    }
  }
  return out
}

interface MentionRow {
  id: string
  actor_username: string
  post_id: string | null
  reply_id: string | null
  excerpt: string
  is_read: unknown
  created_at: string
}

/** Giriş yapmış kullanıcının bahsedilme bildirimleri (yeniden eskiye). */
export async function listMentionNotifications(): Promise<MentionNotification[]> {
  if (!isSupabaseConfigured || !supabase) return []
  if (!getSessionUser()) return []
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('id,actor_username,post_id,reply_id,excerpt,is_read,created_at')
      .order('created_at', { ascending: false })
      .limit(30)
    if (error || !Array.isArray(data)) return []
    return (data as MentionRow[]).map((r) => ({
      id: r.id,
      actorUsername: (r.actor_username ?? '').trim() || 'biri',
      postId: r.post_id,
      replyId: r.reply_id,
      excerpt: r.excerpt ?? '',
      isRead: r.is_read === true,
      createdAt: Date.parse(r.created_at) || 0,
    }))
  } catch {
    return []
  }
}

/** Tüm bahsetmeleri okundu işaretler (sessiz, hata yutmaz). */
export async function markMentionsRead(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return
  const session = getSessionUser()
  if (!session) return
  try {
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', session.id)
      .eq('is_read', false)
  } catch {
    // best effort
  }
}

/** Okunmamış bahsetme sayısı (zil rozeti için). */
export async function countUnreadMentions(): Promise<number> {
  const list = await listMentionNotifications()
  return list.filter((n) => !n.isRead).length
}

/**
 * Yayınlanan yazıdaki etiketleri hedeflere bildirir. Asla hata fırlatmaz;
 * bilinmeyen adlar ve kendi kendini etiketleme sunucuda atlanır.
 */
export async function notifyMentions(
  usernames: string[],
  input: { postId: string; replyId?: string | null; excerpt: string },
): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return
  if (!getSessionUser()) return
  const targets = [...new Set(usernames.map((u) => u.trim()).filter(Boolean))].slice(
    0,
    MAX_MENTIONS_PER_POST,
  )
  if (targets.length === 0) return
  for (const username of targets) {
    try {
      await supabase.rpc('notify_mention', {
        p_username: username,
        p_post_id: input.postId,
        p_reply_id: input.replyId ?? null,
        p_excerpt: input.excerpt.slice(0, 120),
      })
    } catch {
      // tek hedef patlarsa diğerleri yine bildirilir
    }
  }
}
