import { useCallback, useEffect, useState } from 'react'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  FORUM_POST_MAX_LENGTH,
  createForumPost,
  createForumReply,
  deleteForumPost,
  deleteForumReply,
  formatTimeAgo,
  forumDisplayName,
  listForumPosts,
  listForumReplies,
  toggleForumLike,
  type ForumPost,
  type ForumReply,
} from '@/services/forumService'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

export function ForumPage() {
  const pushToast = useToastStore((s) => s.push)
  const [posts, setPosts] = useState<ForumPost[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [liking, setLiking] = useState<Record<string, boolean>>({})

  const myId = getSessionUser()?.id ?? null
  const [feedError, setFeedError] = useState<string | null>(null)

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      try {
        setPosts(await listForumPosts())
        setFeedError(null)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Akış yüklenemedi. Lütfen tekrar dene.'
        setFeedError(msg)
        // Arka plan yenilemeleri (polling/realtime/odak) sessizdir:
        // kalıcı bir arızada her 15 saniyede toast yağmaz.
        if (!opts?.silent) {
          pushToast({ message: msg, tone: 'error' })
        }
      } finally {
        setLoading(false)
      }
    },
    [pushToast],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Canlı akış: başka cihazda paylaşılan gönderi bu ekrana da düşsün.
  // Realtime + periyodik yoklama + odaklanınca yenileme birlikte çalışır;
  // biri çalışmazsa diğeri yakalar. Sessiz yenileme — yükleniyor
  // göstergesiyle akışı boşaltıp "silindi" izlenimi vermez, hata
  // durumunda toast spam'i yapmaz (hata inline banner'da durur).
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return
    const client = supabase
    const quiet = () => {
      void refresh({ silent: true })
    }
    const channel = client
      .channel('forum-feed')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'forum_posts' },
        quiet,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'forum_replies' },
        quiet,
      )
      .subscribe()
    const timer = window.setInterval(quiet, 15000)
    const onFocus = quiet
    const onVisibility = () => {
      if (document.visibilityState === 'visible') quiet()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      void client.removeChannel(channel)
    }
  }, [refresh])

  const publish = async () => {
    if (publishing || !draft.trim()) return
    setPublishing(true)
    try {
      const post = await createForumPost(draft)
      setPosts((prev) => [post, ...prev])
      setDraft('')
      pushToast({ message: 'Gönderin paylaşıldı.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Gönderi paylaşılamadı.', tone: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  const toggleLike = async (post: ForumPost) => {
    if (liking[post.id]) return
    setLiking((s) => ({ ...s, [post.id]: true }))
    // İyimser güncelleme — hata olursa geri al.
    const prev = posts
    setPosts((list) =>
      list.map((p) =>
        p.id === post.id
          ? { ...p, likedByMe: !p.likedByMe, likeCount: p.likeCount + (p.likedByMe ? -1 : 1) }
          : p,
      ),
    )
    try {
      const res = await toggleForumLike(post.id)
      setPosts((list) =>
        list.map((p) =>
          p.id === post.id ? { ...p, likedByMe: res.liked, likeCount: res.likeCount } : p,
        ),
      )
    } catch {
      setPosts(prev)
      pushToast({ message: 'Beğeni işlenemedi.', tone: 'error' })
    } finally {
      setLiking((s) => ({ ...s, [post.id]: false }))
    }
  }

  const remove = async (post: ForumPost) => {
    const prev = posts
    setPosts((list) => list.filter((p) => p.id !== post.id))
    try {
      await deleteForumPost(post.id)
    } catch {
      setPosts(prev)
      pushToast({ message: 'Gönderi silinemedi.', tone: 'error' })
    }
  }

  const bumpReplyCount = useCallback((postId: string, delta: number) => {
    setPosts((list) =>
      list.map((p) =>
        p.id === postId ? { ...p, replyCount: Math.max(0, p.replyCount + delta) } : p,
      ),
    )
  }, [])

  const remaining = FORUM_POST_MAX_LENGTH - draft.length
  const canPublish = draft.trim().length > 0 && remaining >= 0 && !publishing

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col sm:border-x sm:border-exchange-border">
        <div className="sticky top-0 z-10 border-b border-exchange-border bg-exchange-bg/95 px-4 py-3 backdrop-blur">
          <h1 className="text-lg font-bold text-exchange-text">Forum</h1>
          <p className="text-xs text-exchange-muted">Topluluk akışı</p>
        </div>

        <div className="border-b border-exchange-border px-3 py-3 sm:px-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={FORUM_POST_MAX_LENGTH + 20}
            placeholder="Piyasayla ilgili düşüncelerin neler?"
            aria-label="Yeni gönderi"
            className="min-h-20 w-full resize-y rounded-xl border border-exchange-border bg-exchange-card px-3 py-2.5 text-base text-exchange-text outline-none transition-colors focus:border-exchange-yellow placeholder:text-exchange-muted/70 sm:text-sm"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className={cn('shrink-0 font-mono text-xs', remaining < 0 ? 'text-exchange-sell' : 'text-exchange-muted')}>
              {remaining}
            </span>
            <Button size="sm" onClick={() => void publish()} disabled={!canPublish} className="shrink-0 whitespace-nowrap px-5">
              {publishing ? 'Paylaşılıyor…' : 'Paylaş'}
            </Button>
          </div>
        </div>

        <div className="flex-1">
          {feedError && posts.length > 0 && !loading && (
            <div className="mx-3 mt-3 flex items-start justify-between gap-2 rounded-xl border border-exchange-sell/30 bg-exchange-sell/5 px-3 py-2.5 sm:mx-4">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-exchange-text">{feedError}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="shrink-0 whitespace-nowrap text-xs font-bold text-exchange-yellow hover:underline"
              >
                Tekrar dene
              </button>
            </div>
          )}
          {loading ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">Akış yükleniyor…</div>
          ) : posts.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">
              {feedError ? (
                <div className="mx-auto max-w-sm">
                  <p className="leading-relaxed">{feedError}</p>
                  <Button size="sm" onClick={() => void refresh()} className="mt-4 px-5">
                    Tekrar dene
                  </Button>
                </div>
              ) : (
                'Henüz gönderi yok. İlk paylaşan sen ol!'
              )}
            </div>
          ) : (
            <ul>
              {posts.map((post) => (
                <PostRow
                  key={post.id}
                  post={post}
                  isMine={myId !== null && post.userId === myId}
                  myId={myId}
                  liking={!!liking[post.id]}
                  onLike={() => void toggleLike(post)}
                  onDelete={() => void remove(post)}
                  onReplyCount={bumpReplyCount}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function PostRow({
  post,
  isMine,
  myId,
  liking,
  onLike,
  onDelete,
  onReplyCount,
}: {
  post: ForumPost
  isMine: boolean
  myId: string | null
  liking: boolean
  onLike: () => void
  onDelete: () => void
  onReplyCount: (postId: string, delta: number) => void
}) {
  const pushToast = useToastStore((s) => s.push)
  const [showReplies, setShowReplies] = useState(false)
  const [replies, setReplies] = useState<ForumReply[] | null>(null)
  const [loadingReplies, setLoadingReplies] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const [sending, setSending] = useState(false)

  const toggleReplies = async () => {
    const next = !showReplies
    setShowReplies(next)
    if (next && replies === null) {
      setLoadingReplies(true)
      try {
        setReplies(await listForumReplies(post.id))
      } catch {
        pushToast({ message: 'Yanıtlar yüklenemedi.', tone: 'error' })
        setShowReplies(false)
      } finally {
        setLoadingReplies(false)
      }
    }
  }

  const sendReply = async () => {
    if (sending || !replyDraft.trim()) return
    setSending(true)
    try {
      const reply = await createForumReply(post.id, replyDraft)
      setReplies((prev) => [...(prev ?? []), reply])
      setReplyDraft('')
      onReplyCount(post.id, 1)
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Yanıt gönderilemedi.', tone: 'error' })
    } finally {
      setSending(false)
    }
  }

  const removeReply = async (reply: ForumReply) => {
    const prev = replies
    setReplies((list) => (list ?? []).filter((r) => r.id !== reply.id))
    try {
      await deleteForumReply(post.id, reply.id)
      onReplyCount(post.id, -1)
    } catch {
      setReplies(prev)
      pushToast({ message: 'Yanıt silinemedi.', tone: 'error' })
    }
  }

  // Servis zaten görünen adı döndürür; burada tekrar sarmalamak eski
  // satırlarda yanlışlıkla uid yazmış kayıtları da UI'da temizler.
  const displayName = forumDisplayName(post.username, post.userId)

  return (
    <li className="border-b border-exchange-border px-3 py-3 last:border-0 sm:px-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-sm font-extrabold text-exchange-yellow" aria-hidden>
          {(displayName.charAt(0) || '?').toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
              {displayName}
            </span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-exchange-muted">
              {formatTimeAgo(post.createdAt)}
            </span>
            {isMine && (
              <button
                type="button"
                onClick={onDelete}
                aria-label="Gönderiyi sil"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-exchange-muted transition-colors hover:bg-exchange-sell/10 hover:text-exchange-sell"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </button>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-exchange-text">
            {post.content}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onLike}
              disabled={liking}
              aria-label={post.likedByMe ? 'Beğeniyi geri al' : 'Beğen'}
              aria-pressed={post.likedByMe}
              className={cn(
                'flex min-h-[2rem] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold transition-colors disabled:opacity-50',
                post.likedByMe
                  ? 'bg-exchange-sell/10 text-exchange-sell'
                  : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-sell',
              )}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill={post.likedByMe ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
              <span className="font-mono">{post.likeCount > 0 ? post.likeCount : ''}</span>
            </button>
            <button
              type="button"
              onClick={() => void toggleReplies()}
              aria-expanded={showReplies}
              aria-label="Yanıtları göster"
              className={cn(
                'flex min-h-[2rem] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold transition-colors',
                showReplies
                  ? 'bg-exchange-yellow/10 text-exchange-yellow'
                  : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-text',
              )}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
              </svg>
              <span className="font-mono">{post.replyCount > 0 ? post.replyCount : ''}</span>
            </button>
          </div>

          {showReplies && (
            <div className="mt-2 border-t border-exchange-border/60 pt-2">
              {loadingReplies ? (
                <div className="py-3 text-center text-xs text-exchange-muted">Yanıtlar yükleniyor…</div>
              ) : (
                <>
                  {(replies ?? []).map((reply) => (
                    <div key={reply.id} className="flex min-w-0 items-start gap-2 py-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-exchange-surface text-[11px] font-extrabold text-exchange-muted" aria-hidden>
                        {(forumDisplayName(reply.username, reply.userId).charAt(0) || '?').toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1 rounded-xl bg-exchange-surface/60 px-2.5 py-1.5">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-xs font-bold text-exchange-text">
                            {forumDisplayName(reply.username, reply.userId)}
                          </span>
                          <span className="shrink-0 whitespace-nowrap text-[10px] text-exchange-muted">
                            {formatTimeAgo(reply.createdAt)}
                          </span>
                          {myId !== null && reply.userId === myId && (
                            <button
                              type="button"
                              onClick={() => void removeReply(reply)}
                              aria-label="Yanıtı sil"
                              className="shrink-0 text-[11px] font-semibold text-exchange-muted hover:text-exchange-sell"
                            >
                              Sil
                            </button>
                          )}
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-exchange-text">
                          {reply.content}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div className="flex min-w-0 items-center gap-2 py-1.5">
                    <input
                      value={replyDraft}
                      onChange={(e) => setReplyDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void sendReply()
                      }}
                      maxLength={FORUM_POST_MAX_LENGTH + 20}
                      placeholder="Yanıtını yaz…"
                      aria-label="Yanıt yaz"
                      className="h-9 min-w-0 flex-1 rounded-full border border-exchange-border bg-exchange-card px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/70"
                    />
                    <Button
                      size="sm"
                      onClick={() => void sendReply()}
                      disabled={!replyDraft.trim() || sending}
                      className="shrink-0 whitespace-nowrap"
                    >
                      {sending ? '…' : 'Gönder'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
