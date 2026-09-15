import { useCallback, useEffect, useState } from 'react'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import {
  FORUM_POST_MAX_LENGTH,
  createForumPost,
  deleteForumPost,
  formatTimeAgo,
  listForumPosts,
  toggleForumLike,
  type ForumPost,
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

  const refresh = useCallback(async () => {
    try {
      setPosts(await listForumPosts())
    } catch {
      pushToast({ message: 'Akış yüklenemedi. Lütfen tekrar dene.', tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void refresh()
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
          {loading ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">Akış yükleniyor…</div>
          ) : posts.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">
              Henüz gönderi yok. İlk paylaşan sen ol!
            </div>
          ) : (
            <ul>
              {posts.map((post) => (
                <PostRow
                  key={post.id}
                  post={post}
                  isMine={myId !== null && post.userId === myId}
                  liking={!!liking[post.id]}
                  onLike={() => void toggleLike(post)}
                  onDelete={() => void remove(post)}
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
  liking,
  onLike,
  onDelete,
}: {
  post: ForumPost
  isMine: boolean
  liking: boolean
  onLike: () => void
  onDelete: () => void
}) {
  return (
    <li className="border-b border-exchange-border px-3 py-3 last:border-0 sm:px-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-sm font-extrabold text-exchange-yellow" aria-hidden>
          {(post.username.charAt(0) || '?').toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
              {post.username}
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
          <div className="mt-2 flex items-center gap-1">
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
          </div>
        </div>
      </div>
    </li>
  )
}
