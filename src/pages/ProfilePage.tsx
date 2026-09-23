import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { VerifiedBadge } from '@/components/forum/VerifiedBadge'
import { DefaultAvatar } from '@/components/forum/DefaultAvatar'
import { Button } from '@/components/ui/Button'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import {
  followUser,
  formatFollowCount,
  getPublicProfile,
  unfollowUser,
  updateMyBio,
  type PublicProfile,
} from '@/services/profileService'
import {
  formatTimeAgo,
  listForumPostsByAuthor,
  toggleForumLike,
  type ForumPost,
} from '@/services/forumService'
import { cn } from '@/lib/utils'

/**
 * Forum profili (Twitter tarzı): `/profile/:username`.
 *
 * Başlıkta avatar + ad + rozet + bio, altında Gönderi/Takipçi/Takip
 * sayıları; girişte başkasının profilinde Takip Et/Takibi Bırak düğmesi,
 * kendi profilinde tanıtım yazısı düzenleme. Akışta kişinin gönderileri
 * (fotoğraflı dahil) beğeni düğmesiyle listelenir.
 */
export function ProfilePage() {
  const { username = '' } = useParams()
  const navigate = useNavigate()
  const pushToast = useToastStore((s) => s.push)
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [posts, setPosts] = useState<ForumPost[]>([])
  const [loading, setLoading] = useState(true)
  const [followBusy, setFollowBusy] = useState(false)
  const [bioDraft, setBioDraft] = useState('')
  const [bioEditing, setBioEditing] = useState(false)
  const [bioBusy, setBioBusy] = useState(false)

  const me = getSessionUser()
  const isMine = me !== null && me.username.toLowerCase() === username.trim().toLowerCase()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, list] = await Promise.all([
        getPublicProfile(username),
        listForumPostsByAuthor(username).catch(() => [] as ForumPost[]),
      ])
      setProfile(p)
      setPosts(list)
      if (p) setBioDraft(p.bio)
    } finally {
      setLoading(false)
    }
  }, [username])

  useEffect(() => {
    void load()
  }, [load])

  const toggleFollow = async () => {
    if (!profile || followBusy) return
    if (!me) {
      pushToast({ message: 'Takip için giriş yapmalısın.', tone: 'error' })
      return
    }
    setFollowBusy(true)
    try {
      const followers = profile.isFollowing
        ? await unfollowUser(profile.handle)
        : await followUser(profile.handle)
      setProfile({ ...profile, followers, isFollowing: !profile.isFollowing })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'İşlem yapılamadı.', tone: 'error' })
    } finally {
      setFollowBusy(false)
    }
  }

  const saveBio = async () => {
    if (bioBusy) return
    setBioBusy(true)
    try {
      await updateMyBio(bioDraft)
      setProfile((p) => (p ? { ...p, bio: bioDraft.trim().slice(0, 220) } : p))
      setBioEditing(false)
      pushToast({ message: 'Tanıtım yazısı güncellendi.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Kaydedilemedi.', tone: 'error' })
    } finally {
      setBioBusy(false)
    }
  }

  const like = async (post: ForumPost) => {
    try {
      const res = await toggleForumLike(post.id)
      setPosts((list) =>
        list.map((p) => (p.id === post.id ? { ...p, likedByMe: res.liked, likeCount: res.likeCount } : p)),
      )
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Beğenilemedi.', tone: 'error' })
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-16 text-center text-sm text-exchange-muted">Profil yükleniyor…</div>
    )
  }
  if (!profile) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 text-center">
        <p className="text-sm font-bold text-exchange-text">@{username} bulunamadı.</p>
        <p className="mt-1 text-xs text-exchange-muted">Kullanıcı adı değişmiş veya hesap silinmiş olabilir.</p>
        <Button size="sm" variant="outline" className="mt-4" onClick={() => navigate('/forum')}>
          Foruma Dön
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-y-auto overscroll-contain pb-8">
      <div className="border-b border-exchange-border bg-exchange-card px-4 pb-4 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover" />
          ) : (
            <DefaultAvatar size="lg" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-lg font-extrabold text-exchange-text">
                {profile.username}
              </span>
              {profile.verifiedTier !== 'none' && (
                <VerifiedBadge tone={profile.verifiedTier === 'super' ? 'gold' : 'blue'} />
              )}
              {profile.isPersona && (
                <span className="shrink-0 rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-exchange-yellow">
                  Senaryo
                </span>
              )}
            </div>
            <div className="truncate font-mono text-xs text-exchange-muted">@{profile.handle}</div>
          </div>
          {!isMine && me && (
            <Button
              size="sm"
              variant={profile.isFollowing ? 'outline' : undefined}
              onClick={() => void toggleFollow()}
              disabled={followBusy}
              className="shrink-0 whitespace-nowrap"
            >
              {followBusy ? '…' : profile.isFollowing ? 'Takibi Bırak' : 'Takip Et'}
            </Button>
          )}
        </div>

        {isMine && bioEditing ? (
          <div className="mt-3">
            <textarea
              value={bioDraft}
              onChange={(e) => setBioDraft(e.target.value)}
              maxLength={220}
              rows={3}
              placeholder="Kendini tanıt… (en fazla 220 karakter)"
              disabled={bioBusy}
              className="w-full resize-y rounded-xl border border-exchange-border bg-exchange-bg px-3 py-2.5 text-sm leading-relaxed text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setBioEditing(false); setBioDraft(profile.bio) }} disabled={bioBusy}>
                Vazgeç
              </Button>
              <Button size="sm" onClick={() => void saveBio()} disabled={bioBusy}>
                {bioBusy ? 'Kaydediliyor…' : 'Kaydet'}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {profile.bio && (
              <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-exchange-text">
                {profile.bio}
              </p>
            )}
            {isMine && (
              <button
                type="button"
                onClick={() => setBioEditing(true)}
                className="mt-1.5 text-xs font-bold text-exchange-yellow hover:underline"
              >
                {profile.bio ? 'Tanıtım yazısını düzenle' : '+ Tanıtım yazısı ekle'}
              </button>
            )}
          </>
        )}

        <div className="mt-3 flex items-center gap-4 text-sm">
          <span className="text-exchange-muted">
            <span className="font-mono font-extrabold text-exchange-text">{formatFollowCount(profile.posts)}</span>{' '}
            Gönderi
          </span>
          <span className="text-exchange-muted">
            <span className="font-mono font-extrabold text-exchange-text">{formatFollowCount(profile.followers)}</span>{' '}
            Takipçi
          </span>
          <span className="text-exchange-muted">
            <span className="font-mono font-extrabold text-exchange-text">{formatFollowCount(profile.following)}</span>{' '}
            Takip
          </span>
        </div>
      </div>

      <div className="px-3 py-2 sm:px-4">
        {posts.length === 0 ? (
          <div className="py-10 text-center text-sm text-exchange-muted">Henüz gönderi yok.</div>
        ) : (
          <ul>
            {posts.map((p) => (
              <li key={p.id} className="border-b border-exchange-border/60 py-3 last:border-0">
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-exchange-text">
                  {p.content}
                </p>
                {p.imageUrl && (
                  <img
                    src={p.imageUrl}
                    alt=""
                    loading="lazy"
                    className="mt-2 max-h-[22rem] w-full rounded-xl border border-exchange-border/60 object-cover"
                  />
                )}
                <div className="mt-1.5 flex items-center gap-3 text-xs text-exchange-muted">
                  <button
                    type="button"
                    onClick={() => void like(p)}
                    aria-pressed={p.likedByMe}
                    className={cn(
                      'flex items-center gap-1 font-bold transition-colors',
                      p.likedByMe ? 'text-exchange-sell' : 'hover:text-exchange-sell',
                    )}
                  >
                    ♥ <span className="font-mono">{p.likeCount > 0 ? p.likeCount.toLocaleString('tr-TR') : ''}</span>
                  </button>
                  <span className="font-mono">💬 {p.replyCount > 0 ? p.replyCount : ''}</span>
                  <span className="ml-auto shrink-0">{formatTimeAgo(p.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
