import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import { getMyAdminAccess } from '@/services/adminService'
import { extractMentions, notifyMentions } from '@/services/notificationService'
import { uploadForumImageFile, validateForumImageFile } from '@/services/supabaseWallet'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  FORUM_POST_MAX_LENGTH,
  createForumPost,
  createForumReply,
  deleteForumPost,
  deleteForumReply,
  formatLikeCount,
  formatTimeAgo,
  forumDisplayName,
  listForumPosts,
  listForumReplies,
  toggleForumLike,
  toggleForumReplyLike,
  type ForumPost,
  type ForumReply,
} from '@/services/forumService'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { VerifiedBadge } from '@/components/forum/VerifiedBadge'
import { DefaultAvatar } from '@/components/forum/DefaultAvatar'

export function ForumPage() {
  const pushToast = useToastStore((s) => s.push)
  const navigate = useNavigate()
  const openProfile = useCallback(
    (username: string) => {
      const clean = username.trim()
      if (clean) navigate(`/profile/${encodeURIComponent(clean)}`)
    },
    [navigate],
  )
  const [posts, setPosts] = useState<ForumPost[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [liking, setLiking] = useState<Record<string, boolean>>({})
  // Fotoğraflı gönderi (twitter tarzı: açıklama zorunlu + opsiyonel foto).
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const myId = getSessionUser()?.id ?? null
  const myUsername = getSessionUser()?.username ?? null
  const myAvatarUrl = getSessionUser()?.avatarUrl ?? null

  // Forum moderasyonu: süper admin veya ban yetkili alt yönetici
  // herkesin yazısını silebilir (sunucu RLS ile denetler). Süper admin
  // yazılarına yalnız süper admin dokunur (rozet seviyesinden anlaşılır).
  const [canModerate, setCanModerate] = useState(false)
  const [isSuperViewer, setIsSuperViewer] = useState(false)
  useEffect(() => {
    let live = true
    void getMyAdminAccess().then((a) => {
      if (live) {
        setCanModerate(a.isSuperAdmin || a.permissions.includes('ban_users'))
        setIsSuperViewer(a.isSuperAdmin)
      }
    })
    return () => {
      live = false
    }
  }, [])
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

  // Yerel modda realtime yok: bot/admin hamleleri akışa düşsün diye
  // sessiz yoklama (uzak modda yukarıdaki realtime+yoklama çalışır).
  useEffect(() => {
    if (isSupabaseConfigured && supabase) return
    const timer = window.setInterval(() => {
      void refresh({ silent: true })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // Canlı akış: başka cihazda paylaşılan gönderi bu ekrana da düşsün.
  // Birincil kanal realtime'dır (<1 sn). Soket sağlığı izlenir:
  // bağlanana/kopunca yoklama agresifleşir (1 sn), sağlıklı realtime'da
  // yedeğe gevşer (5 sn). Böylece websocket'i engelleyen/koparan
  // hücresel ağlarda bile gecikme ~1 sn tavanında kalır.
  // Mobil özellikle kapsanır: wifi/hücre geçişinde kopan soket yeniden
  // bağlanınca, bfcache'den dönünce (geri tuşu) ve ağ geri gelince
  // anında yakala. Sessiz yenileme — yükleniyor göstergesiyle akışı
  // boşaltıp "silindi" izlenimi vermez, hata durumunda toast spam'i
  // yapmaz (hata inline banner'da durur).
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return
    const client = supabase
    const quiet = () => {
      void refresh({ silent: true })
    }
    // Abort edilene kadar geçerli tek interval — hız değişiminde
    // yeniden kurulur, üst üste binme olmaz.
    let timer: number | undefined
    const armPoll = (ms: number) => {
      window.clearInterval(timer)
      timer = window.setInterval(quiet, ms)
    }
    // İlk bağlanana kadar agresif başla: soket hiç kurulamazsa
    // (bazı hücresel ağlar wss'yi engeller) bu hızda devam eder.
    armPoll(1000)
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
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // (Yeniden) bağlanınca kaçırılanları anında çek, yedeği gevşet.
          quiet()
          armPoll(5000)
        } else if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
          // Soket koptu/engellendi: yoklamayı agresifleştir.
          armPoll(1000)
        }
      })
    const onFocus = quiet
    const onVisibility = () => {
      if (document.visibilityState === 'visible') quiet()
    }
    // bfcache restore / ağ dönüşü: interval ve soket bayatlamış olabilir.
    const onPageShow = () => quiet()
    const onOnline = () => quiet()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('online', onOnline)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('online', onOnline)
      void client.removeChannel(channel)
    }
  }, [refresh])

  const publish = async () => {
    if (publishing || !draft.trim()) return
    const myId = getSessionUser()?.id ?? null
    if (!myId) {
      pushToast({ message: 'Gönderi paylaşmak için giriş yapmalısın.', tone: 'error' })
      return
    }
    setPublishing(true)
    const text = draft
    const file = imageFile
    try {
      // Fotoğraf önce yüklenir (max 10MB kapısı upload öncesi de denetlenir).
      let imageUrl: string | null = null
      if (file) {
        try {
          imageUrl = await uploadForumImageFile(myId, file)
        } catch (err) {
          pushToast({ message: err instanceof Error ? err.message : 'Fotoğraf yüklenemedi.', tone: 'error' })
          setPublishing(false)
          return
        }
      }
      const post = await createForumPost(text, { imageUrl })
      setPosts((prev) => [post, ...prev])
      setDraft('')
      clearImage()
      pushToast({ message: 'Gönderin paylaşıldı.', tone: 'success' })
      // Etiketlenenlere bildirim (best-effort, akışı etkilemez).
      void notifyMentions(extractMentions(text), { postId: post.id, excerpt: text })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Gönderi paylaşılamadı.', tone: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  const onPickImage = (file: File | undefined) => {
    if (!file) return
    try {
      validateForumImageFile(file)
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Fotoğraf eklenemedi.', tone: 'error' })
      return
    }
    if (imagePreview) {
      try {
        URL.revokeObjectURL(imagePreview)
      } catch {
        // yoksay
      }
    }
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  const clearImage = () => {
    if (imagePreview) {
      try {
        URL.revokeObjectURL(imagePreview)
      } catch {
        // yoksay
      }
    }
    setImageFile(null)
    setImagePreview(null)
    if (fileRef.current) fileRef.current.value = ''
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
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-exchange-border bg-exchange-bg/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold text-exchange-text">Forum</h1>
            <p className="text-xs text-exchange-muted">Topluluk akışı</p>
          </div>
          {myId && myUsername && (
            <button
              type="button"
              onClick={() => openProfile(myUsername)}
              className="flex shrink-0 items-center gap-2 rounded-full border border-exchange-border bg-exchange-card py-1.5 pl-1.5 pr-3.5 text-xs font-bold text-exchange-text transition-colors hover:border-exchange-yellow hover:text-exchange-yellow active:scale-95"
              aria-label="Profilim"
            >
              {myAvatarUrl ? (
                <img src={myAvatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
              ) : (
                <DefaultAvatar size="xs" />
              )}
              Profilim
            </button>
          )}
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
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            aria-label="Gönderiye fotoğraf ekle"
            className="hidden"
            onChange={(e) => onPickImage(e.target.files?.[0])}
          />
          {imagePreview && (
            <div className="relative mt-2 overflow-hidden rounded-xl border border-exchange-border/60">
              <img
                src={imagePreview}
                alt="Eklenecek fotoğraf önizlemesi"
                className="max-h-60 w-full object-cover"
              />
              <button
                type="button"
                onClick={clearImage}
                aria-label="Fotoğrafı kaldır"
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-sm font-bold text-white transition-colors hover:bg-black"
              >
                ✕
              </button>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={publishing}
                aria-label="Fotoğraf ekle (en fazla 10MB)"
                title="Fotoğraf ekle (en fazla 10MB)"
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50',
                  imageFile
                    ? 'bg-exchange-yellow/15 text-exchange-yellow'
                    : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-yellow',
                )}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
              </button>
              <span className={cn('shrink-0 font-mono text-xs', remaining < 0 ? 'text-exchange-sell' : 'text-exchange-muted')}>
                {remaining}
              </span>
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
                  canModerate={canModerate}
                  isSuperViewer={isSuperViewer}
                  myId={myId}
                  liking={!!liking[post.id]}
                  onLike={() => void toggleLike(post)}
                  onDelete={() => void remove(post)}
                  onReplyCount={bumpReplyCount}
                  onOpenProfile={openProfile}
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
  canModerate,
  isSuperViewer,
  myId,
  liking,
  onLike,
  onDelete,
  onReplyCount,
  onOpenProfile,
}: {
  post: ForumPost
  isMine: boolean
  canModerate: boolean
  isSuperViewer: boolean
  myId: string | null
  liking: boolean
  onLike: () => void
  onDelete: () => void
  onReplyCount: (postId: string, delta: number) => void
  onOpenProfile: (username: string) => void
}) {
  const pushToast = useToastStore((s) => s.push)
  const [showReplies, setShowReplies] = useState(false)
  const [replies, setReplies] = useState<ForumReply[] | null>(null)
  const [loadingReplies, setLoadingReplies] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [likingReply, setLikingReply] = useState<Record<string, boolean>>({})
  const [replyFile, setReplyFile] = useState<File | null>(null)
  const [replyPreview, setReplyPreview] = useState<string | null>(null)
  const replyFileRef = useRef<HTMLInputElement>(null)
  // Instagram tarzı büyütme: avatar ya da gönderi fotoğrafına dokununca.
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)

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
    const myId = getSessionUser()?.id ?? null
    if (!myId) {
      pushToast({ message: 'Yanıt yazmak için giriş yapmalısın.', tone: 'error' })
      return
    }
    setSending(true)
    const text = replyDraft
    const file = replyFile
    try {
      let imageUrl: string | null = null
      if (file) {
        try {
          imageUrl = await uploadForumImageFile(myId, file)
        } catch (err) {
          pushToast({ message: err instanceof Error ? err.message : 'Fotoğraf yüklenemedi.', tone: 'error' })
          setSending(false)
          return
        }
      }
      const reply = await createForumReply(post.id, text, { imageUrl })
      setReplies((prev) => [...(prev ?? []), reply])
      setReplyDraft('')
      clearReplyImage()
      onReplyCount(post.id, 1)
      // Etiketlenenlere bildirim (best-effort, akışı etkilemez).
      void notifyMentions(extractMentions(text), { postId: post.id, replyId: reply.id, excerpt: text })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Yanıt gönderilemedi.', tone: 'error' })
    } finally {
      setSending(false)
    }
  }

  const onPickReplyImage = (file: File | undefined) => {
    if (!file) return
    try {
      validateForumImageFile(file)
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Fotoğraf eklenemedi.', tone: 'error' })
      return
    }
    if (replyPreview) {
      try {
        URL.revokeObjectURL(replyPreview)
      } catch {
        // yoksay
      }
    }
    setReplyFile(file)
    setReplyPreview(URL.createObjectURL(file))
  }

  const clearReplyImage = () => {
    if (replyPreview) {
      try {
        URL.revokeObjectURL(replyPreview)
      } catch {
        // yoksay
      }
    }
    setReplyFile(null)
    setReplyPreview(null)
    if (replyFileRef.current) replyFileRef.current.value = ''
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

  const toggleReplyLike = async (reply: ForumReply) => {
    if (likingReply[reply.id]) return
    setLikingReply((s) => ({ ...s, [reply.id]: true }))
    const prev = replies
    setReplies((list) =>
      (list ?? []).map((r) =>
        r.id === reply.id
          ? { ...r, likedByMe: !r.likedByMe, likeCount: r.likeCount + (r.likedByMe ? -1 : 1) }
          : r,
      ),
    )
    try {
      const res = await toggleForumReplyLike(post.id, reply.id)
      setReplies((list) =>
        (list ?? []).map((r) =>
          r.id === reply.id ? { ...r, likedByMe: res.liked, likeCount: res.likeCount } : r,
        ),
      )
    } catch {
      setReplies(prev)
      pushToast({ message: 'Beğeni işlenemedi.', tone: 'error' })
    } finally {
      setLikingReply((s) => ({ ...s, [reply.id]: false }))
    }
  }

  // Servis zaten görünen adı döndürür; burada tekrar sarmalamak eski
  // satırlarda yanlışlıkla uid yazmış kayıtları da UI'da temizler.
  const displayName = forumDisplayName(post.username, post.userId)

  // Silme görünürlüğü: kendin + (yetkili moderatör ve hedef süper değil).
  const canDeletePost = isMine || (canModerate && (isSuperViewer || post.verifiedTier !== 'super'))
  const canDeleteReply = (reply: ForumReply) =>
    (myId !== null && reply.userId === myId) ||
    (canModerate && (isSuperViewer || reply.verifiedTier !== 'super'))

  const handleDeletePost = () => {
    // Başkasının yazısını silen moderatörden onay alınır.
    if (!isMine && !window.confirm(`"${displayName}" kullanıcısının gönderisi silinsin mi?`)) return
    onDelete()
  }

  const handleDeleteReply = (reply: ForumReply) => {
    const mine = myId !== null && reply.userId === myId
    if (!mine && !window.confirm('Bu yanıt silinsin mi?')) return
    void removeReply(reply)
  }

  return (
    <li className="border-b border-exchange-border px-3 py-3 last:border-0 sm:px-4">
      <div className="flex min-w-0 items-start gap-2.5">
        {post.avatarUrl ? (
          <button
            type="button"
            onClick={() => setLightbox({ src: post.avatarUrl!, alt: `${displayName} profil fotoğrafı` })}
            aria-label={`${displayName} profil fotoğrafını büyüt`}
            className="shrink-0 rounded-full transition-transform active:scale-95"
          >
            <img
              src={post.avatarUrl}
              alt=""
              className="h-9 w-9 rounded-full object-cover"
            />
          </button>
        ) : (
          <DefaultAvatar size="md" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                <button
                  type="button"
                  onClick={() => onOpenProfile(post.username)}
                  title={`${displayName} profilini aç`}
                  className="min-w-0 max-w-full truncate text-sm font-bold text-exchange-text transition-colors hover:text-exchange-yellow hover:underline"
                >
                  {post.displayName || displayName}
                </button>
              {post.verifiedTier !== 'none' && (
                <VerifiedBadge tone={post.verifiedTier === 'super' ? 'gold' : 'blue'} />
              )}
              {post.userTag && (
                <span className="max-w-full truncate rounded-full bg-exchange-yellow/15 px-2 py-px text-[10px] font-bold text-exchange-yellow">
                  {post.userTag}
                </span>
              )}
              </span>
              <button
                type="button"
                onClick={() => onOpenProfile(post.username)}
                className="mt-px w-fit max-w-full truncate text-left font-mono text-[11px] text-exchange-muted transition-colors hover:text-exchange-yellow hover:underline"
              >
                @{post.username.toLowerCase()}
              </button>
            </span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-exchange-muted">
              {formatTimeAgo(post.createdAt)}
            </span>
            {canDeletePost && (
              <button
                type="button"
                onClick={handleDeletePost}
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
            {renderContentWithMentions(post.content, onOpenProfile)}
          </p>
          {post.imageUrl && (
            <button
              type="button"
              onClick={() => setLightbox({ src: post.imageUrl!, alt: `${displayName} gönderi fotoğrafı` })}
              aria-label="Gönderi fotoğrafını büyüt"
              className="mt-2 block w-full min-w-0 overflow-hidden rounded-xl border border-exchange-border/60 transition-transform active:scale-[0.99]"
            >
              <img
                src={post.imageUrl}
                alt=""
                loading="lazy"
                className="max-h-[26rem] w-full object-cover"
              />
            </button>
          )}
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
              <span className="font-mono">{formatLikeCount(post.likeCount)}</span>
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
              <span className="font-mono">{formatLikeCount(post.replyCount)}</span>
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
                      {reply.avatarUrl ? (
                        <button
                          type="button"
                          onClick={() => setLightbox({ src: reply.avatarUrl!, alt: `${forumDisplayName(reply.username, reply.userId)} profil fotoğrafı` })}
                          aria-label="Profil fotoğrafını büyüt"
                          className="shrink-0 rounded-full transition-transform active:scale-95"
                        >
                          <img
                            src={reply.avatarUrl}
                            alt=""
                            className="h-7 w-7 rounded-full object-cover"
                          />
                        </button>
                      ) : (
                        <DefaultAvatar size="xs" />
                      )}
                      <div className="min-w-0 flex-1 rounded-xl bg-exchange-surface/60 px-2.5 py-1.5">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                              <button
                                type="button"
                                onClick={() => onOpenProfile(reply.username)}
                                className="min-w-0 max-w-full truncate text-xs font-bold text-exchange-text transition-colors hover:text-exchange-yellow hover:underline"
                              >
                                {reply.displayName || forumDisplayName(reply.username, reply.userId)}
                              </button>
                              {reply.verifiedTier !== 'none' && (
                                <VerifiedBadge
                                  small
                                  tone={reply.verifiedTier === 'super' ? 'gold' : 'blue'}
                                />
                              )}
                              {reply.userTag && (
                                <span className="max-w-full truncate rounded-full bg-exchange-yellow/15 px-1.5 py-px text-[9px] font-bold text-exchange-yellow">
                                  {reply.userTag}
                                </span>
                              )}
                            </span>
                            <span className="mt-px w-fit max-w-full truncate font-mono text-[10px] text-exchange-muted">
                              @{reply.username.toLowerCase()}
                            </span>
                          </span>
                          <span className="shrink-0 whitespace-nowrap text-[10px] text-exchange-muted">
                            {formatTimeAgo(reply.createdAt)}
                          </span>
                          {canDeleteReply(reply) ? (
                            <button
                              type="button"
                              onClick={() => handleDeleteReply(reply)}
                              aria-label="Yanıtı sil"
                              className="shrink-0 text-[11px] font-semibold text-exchange-muted hover:text-exchange-sell"
                            >
                              Sil
                            </button>
                          ) : null}
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-exchange-text">
                          {renderContentWithMentions(reply.content, onOpenProfile)}
                        </p>
                        <div className="mt-1 flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void toggleReplyLike(reply)}
                            disabled={!!likingReply[reply.id]}
                            aria-label={reply.likedByMe ? 'Yanıt beğenisini geri al' : 'Yanıtı beğen'}
                            aria-pressed={reply.likedByMe}
                            className={cn(
                              'flex min-h-[1.75rem] shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-bold transition-colors disabled:opacity-50',
                              reply.likedByMe
                                ? 'bg-exchange-sell/10 text-exchange-sell'
                                : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-sell',
                            )}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill={reply.likedByMe ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                            </svg>
                            <span className="font-mono">{formatLikeCount(reply.likeCount)}</span>
                          </button>
                        </div>
                        {reply.imageUrl && (
                          <button
                            type="button"
                            onClick={() => setLightbox({ src: reply.imageUrl!, alt: 'Yanıt fotoğrafı' })}
                            aria-label="Yanıt fotoğrafını büyüt"
                            className="mt-1.5 block w-full min-w-0 overflow-hidden rounded-lg border border-exchange-border/50"
                          >
                            <img
                              src={reply.imageUrl}
                              alt=""
                              loading="lazy"
                              className="max-h-64 w-full object-cover"
                            />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="flex min-w-0 items-center gap-2 py-1.5">
                    <input
                      ref={replyFileRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      aria-label="Yanıta fotoğraf ekle"
                      className="hidden"
                      onChange={(e) => onPickReplyImage(e.target.files?.[0])}
                    />
                    <button
                      type="button"
                      onClick={() => replyFileRef.current?.click()}
                      disabled={sending}
                      aria-label="Yanıta fotoğraf ekle (en fazla 10MB)"
                      title="Fotoğraf ekle (en fazla 10MB)"
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50',
                        replyFile
                          ? 'bg-exchange-yellow/15 text-exchange-yellow'
                          : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-yellow',
                      )}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                      </svg>
                    </button>
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
                  {replyPreview && (
                    <div className="relative mb-1.5 ml-9 overflow-hidden rounded-lg border border-exchange-border/60">
                      <img
                        src={replyPreview}
                        alt="Eklenecek fotoğraf önizlemesi"
                        className="max-h-40 w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={clearReplyImage}
                        aria-label="Fotoğrafı kaldır"
                        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-xs font-bold text-white hover:bg-black"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </li>
  )
}

/**
 * Instagram tarzı büyütme: karartılmış zeminde ortalanmış fotoğraf.
 * Mobilde taşmaz (kenar boşluklu, yükseklik sınırlı), zemine/✕/Escape
 * ile kapanır, arka plan kaymaz.
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Kapat"
        className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg font-bold text-white transition-colors hover:bg-white/20"
      >
        ✕
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] max-w-full rounded-2xl border border-white/10 object-contain shadow-2xl"
      />
    </div>
  )
}

/**
 * @kullanıcı etiketlerini vurgulama: metni parçalayıp etiketleri renkli,
 * TIKLANABİLİR gösterir (dokununca ilgili profil açılır). Eşleşme kuralı
 * `extractMentions` ile birebir aynıdır (e-postalar etiket sayılmaz).
 */
const MENTION_SPLIT_RE = /(^|[^A-Za-z0-9_çÇğĞıİöÖşŞüÜ])(@[A-Za-z0-9_çÇğĞıİöÖşŞüÜ]{3,20})/gu

export function renderContentWithMentions(
  content: string,
  onOpenProfile?: (username: string) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  MENTION_SPLIT_RE.lastIndex = 0
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_SPLIT_RE.exec(content)) !== null) {
    const at = m.index + m[1].length
    if (at > last) out.push(content.slice(last, at))
    const handle = m[2].slice(1)
    out.push(
      onOpenProfile ? (
        <button
          key={`m${i++}`}
          type="button"
          onClick={() => onOpenProfile(handle)}
          title={`@${handle} profilini aç`}
          className="font-semibold text-exchange-yellow transition-colors hover:underline active:scale-95"
        >
          {m[2]}
        </button>
      ) : (
        <span key={`m${i++}`} className="font-semibold text-exchange-yellow">
          {m[2]}
        </span>
      ),
    )
    last = at + m[2].length
  }
  if (last < content.length) out.push(content.slice(last))
  if (out.length === 0) out.push(content)
  return out
}
