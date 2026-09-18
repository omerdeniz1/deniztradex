import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import {
  ADMIN_PERMISSIONS,
  deleteCoinNews,
  deleteForumPostsBulk,
  deleteUser,
  getMyAdminAccess,
  getPlatformStats,
  hasAdminPermission,
  listAdminUsers,
  listCoinNews,
  listCoinOverrides,
  listForumAdminPosts,
  listVirtualCoins,
  sendPasswordReset,
  setAdminPrivileges,
  setMoneyRestrictions,
  setUserBanned,
  setUserFrozen,
  updateCoinStatus,
  updateUserBalance,
  validateBalanceInput,
  type AdminAccess,
  type AdminForumPost,
  type AdminPermission,
  type AdminUser,
  type CoinNewsItem,
  type CoinStatus,
  type PlatformStats,
  type VirtualCoin,
} from '@/services/adminService'
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncementsStatus,
  listAnnouncements,
  type Announcement,
  type AnnouncementsSetupStatus,
} from '@/services/announcementService'
import {
  NEWS_BODY_MAX,
  NEWS_PUMP_TARGET_PCT,
  NEWS_TITLE_MAX,
  pumpCoinWithNews,
  type PumpDirection,
} from '@/services/coinPumpService'
import {
  deleteEvent,
  EVENT_BODY_MAX,
  EVENT_TITLE_MAX,
  listEvents,
  saveEvent,
  type EventInput,
  type EventItem,
} from '@/services/eventService'
import { CHARACTER_BOTS, runCharacterBot } from '@/services/botSimulationService'
import { cn, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { DefaultAvatar } from '@/components/forum/DefaultAvatar'

export function AdminPage() {
  const [access, setAccess] = useState<AdminAccess | null>(null)
  const [checking, setChecking] = useState(true)

  // Admin Guard: yetki DB'den okunur (süper admin veya izinli alt yönetici).
  // Oturumsuz / yetkisiz kullanıcı ana sayfaya yönlendirilir — istemcideki
  // hiçbir bayrak yetki sayılmaz, gerçek denetim sunucudadır (RLS + RPC).
  useEffect(() => {
    let live = true
    void getMyAdminAccess().then((a) => {
      if (live) {
        setAccess(a)
        setChecking(false)
      }
    })
    return () => {
      live = false
    }
  }, [])

  if (checking) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-16 text-sm text-exchange-muted">
        Yetki denetleniyor…
      </div>
    )
  }
  if (!access || (!access.isSuperAdmin && access.permissions.length === 0)) {
    return <Navigate to="/" replace />
  }
  return <AdminDashboard access={access} />
}

function AdminDashboard({ access }: { access: AdminAccess }) {
  const pushToast = useToastStore((s) => s.push)
  const myId = getSessionUser()?.id ?? null
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<
    | { mode: 'balance'; user: AdminUser }
    | { mode: 'freeze'; user: AdminUser }
    | { mode: 'ban'; user: AdminUser }
    | { mode: 'delete'; user: AdminUser }
    | { mode: 'password'; user: AdminUser }
    | { mode: 'restrict'; user: AdminUser }
    | { mode: 'privs'; user: AdminUser | null }
    | { mode: 'revoke'; user: AdminUser }
    | null
  >(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const can = useCallback((perm: AdminPermission) => hasAdminPermission(access, perm), [access])

  // Sekme yapısı (mobil + masaüstü): büyük bloklar üstte yatay
  // kaydırılabilir sekmelere bölünür, yalnızca seçili sekme gösterilir.
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'forum' | 'admins' | 'announce' | 'bots' | 'coins' | 'events'>('overview')
  const showForum = can('ban_users')
  const showAdmins = can('manage_admins')
  // Sistem duyurusu, botlar, coinler ve etkinlikler YALNIZCA süper admin (sunucu da aynısını zorlar).
  const showAnnounce = access.isSuperAdmin
  const showBots = access.isSuperAdmin
  const showCoins = access.isSuperAdmin
  const showEvents = access.isSuperAdmin
  const tabs = useMemo(() => {
    const list: { id: 'overview' | 'users' | 'forum' | 'admins' | 'announce' | 'bots' | 'coins' | 'events'; label: string }[] = [
      { id: 'overview', label: 'Genel Bakış' },
      { id: 'users', label: 'Kullanıcılar' },
    ]
    if (showForum) list.push({ id: 'forum', label: 'Forum' })
    if (showAdmins) list.push({ id: 'admins', label: 'Yöneticiler' })
    if (showAnnounce) list.push({ id: 'announce', label: 'Duyurular' })
    if (showBots) list.push({ id: 'bots', label: 'Botlar' })
    if (showCoins) list.push({ id: 'coins', label: 'Coinler' })
    if (showEvents) list.push({ id: 'events', label: 'Etkinlikler' })
    return list
  }, [showForum, showAdmins, showAnnounce, showBots, showCoins, showEvents])

  // Süper admin hedef dokunulmazlığı: süper admin satırlarına yalnız
  // süper admin dokunur (sunucu da aynı kuralı zorunlu kılar).
  const canTouch = useCallback(
    (u: AdminUser) => access.isSuperAdmin || !u.isAdmin,
    [access.isSuperAdmin],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, u] = await Promise.all([getPlatformStats(), listAdminUsers()])
      setStats(s)
      setUsers(u)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Yüklenemedi. Lütfen tekrar dene.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    )
  }, [users, query])

  const admins = useMemo(
    () => users.filter((u) => u.isAdmin || u.permissions.length > 0),
    [users],
  )
  const frozenCount = users.filter((u) => u.isFrozen).length
  const bannedCount = users.filter((u) => u.isBanned).length

  const fail = (err: unknown, fallback: string) =>
    pushToast({ message: err instanceof Error ? err.message : fallback, tone: 'error' })

  const saveBalance = async (user: AdminUser, raw: string) => {
    let value: number
    try {
      value = validateBalanceInput(raw)
    } catch (err) {
      fail(err, 'Geçersiz bakiye.')
      return
    }
    setBusyId(user.id)
    try {
      await updateUserBalance(user.id, value)
      setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, balance: value } : u)))
      setStats((s) =>
        s ? { ...s, totalBalance: s.totalBalance - user.balance + value } : s,
      )
      setModal(null)
      pushToast({ message: `${user.username} bakiyesi güncellendi.`, tone: 'success' })
    } catch (err) {
      fail(err, 'Bakiye güncellenemedi.')
    } finally {
      setBusyId(null)
    }
  }

  const toggleFreeze = async (user: AdminUser) => {
    setBusyId(user.id)
    try {
      await setUserFrozen(user.id, !user.isFrozen)
      setUsers((list) =>
        list.map((u) => (u.id === user.id ? { ...u, isFrozen: !u.isFrozen } : u)),
      )
      setStats((s) =>
        s ? { ...s, frozenCount: s.frozenCount + (user.isFrozen ? -1 : 1) } : s,
      )
      setModal(null)
      pushToast({
        message: user.isFrozen ? `${user.username} hesabı çözüldü.` : `${user.username} hesabı donduruldu.`,
        tone: user.isFrozen ? 'success' : 'info',
      })
    } catch (err) {
      fail(err, 'İşlem yapılamadı.')
    } finally {
      setBusyId(null)
    }
  }

  const toggleBan = async (user: AdminUser) => {    setBusyId(user.id)
    try {
      await setUserBanned(user.id, !user.isBanned)
      setUsers((list) =>
        list.map((u) => (u.id === user.id ? { ...u, isBanned: !u.isBanned } : u)),
      )
      setStats((s) =>
        s ? { ...s, bannedCount: s.bannedCount + (user.isBanned ? -1 : 1) } : s,
      )
      setModal(null)
      pushToast({
        message: user.isBanned
          ? `${user.username} yasağı kaldırıldı.`
          : `${user.username} kalıcı olarak yasaklandı.`,
        tone: user.isBanned ? 'success' : 'info',
      })
    } catch (err) {
      fail(err, 'Yasaklama işlemi yapılamadı.')
    } finally {
      setBusyId(null)
    }
  }

  const removeUser = async (user: AdminUser) => {
    setBusyId(user.id)
    try {
      const name = await deleteUser(user.id)
      setUsers((list) => list.filter((u) => u.id !== user.id))
      setStats((s) =>
        s
          ? {
              ...s,
              totalUsers: Math.max(0, s.totalUsers - 1),
              totalBalance: s.totalBalance - user.balance,
              frozenCount: s.frozenCount - (user.isFrozen ? 1 : 0),
              bannedCount: s.bannedCount - (user.isBanned ? 1 : 0),
            }
          : s,
      )
      setModal(null)
      pushToast({
        message: `${name || user.username} komple silindi — kullanıcı adı yeniden kayda açık.`,
        tone: 'success',
      })
    } catch (err) {
      fail(err, 'Kullanıcı silinemedi.')
    } finally {
      setBusyId(null)
    }
  }

  const saveRestrictions = async (
    user: AdminUser,
    input: { depositBlocked: boolean; withdrawBlocked: boolean },
  ) => {    setBusyId(user.id)
    try {
      await setMoneyRestrictions(user.id, input)
      setUsers((list) =>
        list.map((u) => (u.id === user.id ? { ...u, ...input } : u)),
      )
      setModal(null)
      pushToast({ message: `${user.username} para kısıtları güncellendi.`, tone: 'success' })
    } catch (err) {
      fail(err, 'Kısıtlama güncellenemedi.')
    } finally {
      setBusyId(null)
    }
  }

  const resetPassword = async (user: AdminUser) => {
    setBusyId(user.id)
    try {
      await sendPasswordReset(user.email)
      setModal(null)
      pushToast({
        message: `${user.email} adresine sıfırlama bağlantısı gönderildi.`,
        tone: 'success',
      })
    } catch (err) {
      fail(err, 'Sıfırlama e-postası gönderilemedi.')
    } finally {
      setBusyId(null)
    }
  }

  const savePrivs = async (userId: string, isAdmin: boolean, permissions: AdminPermission[]) => {
    setBusyId(userId)
    try {
      await setAdminPrivileges(userId, { isAdmin, permissions })
      setUsers((list) =>
        list.map((u) => (u.id === userId ? { ...u, isAdmin, permissions } : u)),
      )
      setModal(null)
      pushToast({ message: 'Yönetici yetkileri güncellendi.', tone: 'success' })
    } catch (err) {
      fail(err, 'Yetkiler güncellenemedi.')
    } finally {
      setBusyId(null)
    }
  }

  const revokePrivs = async (user: AdminUser) => {
    setBusyId(user.id)
    try {
      await setAdminPrivileges(user.id, { isAdmin: false, permissions: [] })
      setUsers((list) =>
        list.map((u) =>
          u.id === user.id ? { ...u, isAdmin: false, permissions: [] } : u,
        ),
      )
      setModal(null)
      pushToast({ message: `${user.username} yöneticilikten çıkarıldı.`, tone: 'success' })
    } catch (err) {
      fail(err, 'Yetki kaldırılamadı.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-3 py-4 pb-28 sm:px-4 sm:py-6 md:pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-bold text-exchange-text sm:text-xl">Admin Panel</h1>
              <span className="shrink-0 rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-exchange-yellow">
                {access.isSuperAdmin ? 'Süper Admin' : 'Alt Yönetici'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-exchange-muted">Platform özeti ve kullanıcı yönetimi</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? 'Yükleniyor…' : 'Yenile'}
          </Button>
        </div>

        {/* Sekme barı: tüm ekranlarda yatay kaydırılabilir, yalnızca seçili sekme gösterilir */}
        <div className="mt-3">
          <div
            role="tablist"
            aria-label="Admin bölümleri"
            className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
          >
            {tabs.map((t) => {
              const active = activeTab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    'shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-xs font-bold transition-colors active:scale-95',
                    active
                      ? 'border-exchange-yellow bg-exchange-yellow text-black'
                      : 'border-exchange-border bg-exchange-card text-exchange-muted hover:text-exchange-text',
                  )}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-start justify-between gap-2 rounded-xl border border-exchange-sell/30 bg-exchange-sell/5 px-3 py-2.5">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-exchange-text">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="shrink-0 whitespace-nowrap text-xs font-bold text-exchange-yellow hover:underline"
            >
              Tekrar dene
            </button>
          </div>
        )}

        {/* Genel Bakış: istatistik kartları (yalnızca sekme seçiliyken) */}
        <div
          role="tabpanel"
          aria-label="Genel Bakış"
          className={cn(activeTab === 'overview' ? 'block' : 'hidden')}
        >
        <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatCard
            label="Toplam Kullanıcı"
            value={stats ? formatNumber(stats.totalUsers, 0) : '—'}
            icon={<UsersIcon />}
          />
          <StatCard
            label="Sistem Bakiyesi"
            value={stats ? `${formatNumber(stats.totalBalance, 2)} USDT` : '—'}
            icon={<WalletIcon />}
            accent
          />
          <StatCard
            label="Forum Gönderisi"
            value={stats ? formatNumber(stats.forumPosts, 0) : '—'}
            icon={<ChatIcon />}
          />
          <StatCard
            label="Bugünkü İşlem"
            value={stats ? formatNumber(stats.transactionsToday, 0) : '—'}
            icon={<ChartIcon />}
          />
        </div>
        </div>

        {/* Kullanıcı yönetimi */}
        <div
          role="tabpanel"
          aria-label="Kullanıcılar"
          className={cn(activeTab === 'users' ? 'block' : 'hidden')}
        >
        <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-exchange-border px-3 py-3 sm:px-4">
            <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
              Kullanıcılar
              <span className="ml-2 font-mono text-xs font-semibold text-exchange-muted">
                {filtered.length}
              </span>
              {frozenCount > 0 && (
                <span className="ml-2 rounded-full bg-exchange-sell/10 px-2 py-0.5 text-[10px] font-bold text-exchange-sell">
                  {frozenCount} dondurulmuş
                </span>
              )}
              {bannedCount > 0 && (
                <span className="ml-2 rounded-full bg-exchange-sell/20 px-2 py-0.5 text-[10px] font-bold text-exchange-sell">
                  {bannedCount} yasaklı
                </span>
              )}
            </h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Kullanıcı / e-posta ara…"
              aria-label="Kullanıcı ara"
              className="h-9 w-full min-w-0 flex-1 rounded-full border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/70 sm:w-56 sm:flex-none"
            />
          </div>

          {loading && users.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">
              Kullanıcılar yükleniyor…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">
              {users.length === 0 ? 'Kayıtlı kullanıcı bulunamadı.' : 'Aramaya uygun kullanıcı yok.'}
            </div>
          ) : (
            <>
              {/* Mobil: her kullanıcı dikey bir kart (tablo yok → yatay taşma yok).
                  Butonlar 2'li grid içinde tam genişlikte sığar. */}
              <ul className="grid min-w-0 gap-2 p-3 md:hidden">
                {filtered.map((u) => {
                  const isSelf = myId !== null && u.id === myId
                  return (
                    <li
                      key={u.id}
                      className="min-w-0 rounded-xl border border-exchange-border bg-exchange-bg/60 p-3"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {u.avatarUrl ? (
                          <img
                            src={u.avatarUrl}
                            alt=""
                            className="h-9 w-9 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <DefaultAvatar size="md" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-exchange-text">
                            {u.username}
                            {isSelf && (
                              <span className="ml-1.5 text-[10px] font-bold uppercase text-exchange-muted">
                                (sen)
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-exchange-muted">
                            {u.email || '—'}
                          </div>
                          {u.isAdmin ? (
                            <div className="text-[10px] font-bold uppercase tracking-wide text-exchange-yellow">
                              Süper Admin
                            </div>
                          ) : (
                            u.permissions.length > 0 && (
                              <div className="text-[10px] font-bold uppercase tracking-wide text-exchange-muted">
                                Alt Yönetici
                              </div>
                            )
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-exchange-muted">
                            Bakiye
                          </div>
                          <div className="font-mono text-sm font-extrabold text-exchange-text">
                            {formatNumber(u.balance, 2)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2">
                        <StatusPill user={u} />
                      </div>
                      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                        {can('edit_balance') && canTouch(u) && (
                          <CardButton
                            label="Bakiye"
                            title={`${u.username} bakiyesini düzenle`}
                            disabled={busyId === u.id}
                            onClick={() => setModal({ mode: 'balance', user: u })}
                          />
                        )}
                        {can('ban_users') && canTouch(u) && (
                          <>
                            <button
                              type="button"
                              onClick={() => setModal({ mode: 'freeze', user: u })}
                              disabled={busyId === u.id || isSelf}
                              title={
                                isSelf
                                  ? 'Kendi hesabında işlem yapamazsın'
                                  : u.isFrozen
                                    ? `${u.username} hesabını çöz`
                                    : `${u.username} hesabını dondur`
                              }
                              className={cn(
                                'w-full rounded-lg border px-2.5 py-2 text-xs font-bold transition-colors disabled:opacity-40',
                                u.isFrozen
                                  ? 'border-exchange-buy/40 text-exchange-buy hover:bg-exchange-buy/10'
                                  : 'border-exchange-sell/40 text-exchange-sell hover:bg-exchange-sell/10',
                              )}
                            >
                              {busyId === u.id ? '…' : u.isFrozen ? 'Çöz' : 'Dondur'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setModal({ mode: 'ban', user: u })}
                              disabled={busyId === u.id || isSelf}
                              title={
                                isSelf
                                  ? 'Kendi hesabında işlem yapamazsın'
                                  : u.isBanned
                                    ? `${u.username} yasağını kaldır`
                                    : `${u.username} hesabını kalıcı yasakla`
                              }
                              className={cn(
                                'w-full rounded-lg border px-2.5 py-2 text-xs font-bold transition-colors disabled:opacity-40',
                                u.isBanned
                                  ? 'border-exchange-buy/40 text-exchange-buy hover:bg-exchange-buy/10'
                                  : 'border-exchange-sell/60 bg-exchange-sell/10 text-exchange-sell hover:bg-exchange-sell/20',
                              )}
                            >
                              {busyId === u.id ? '…' : u.isBanned ? 'Yasağı Kaldır' : 'Yasakla'}
                            </button>
                          </>
                        )}
                        {can('change_password') && u.email && canTouch(u) && (
                          <CardButton
                            label="Şifre"
                            title={`${u.username} için şifre sıfırlama e-postası gönder`}
                            disabled={busyId === u.id}
                            onClick={() => setModal({ mode: 'password', user: u })}
                          />
                        )}
                        {can('restrict_money') && canTouch(u) && (
                          <CardButton
                            label="Kısıtla"
                            title={`${u.username} için para yatırma/çekme kısıtları`}
                            disabled={busyId === u.id}
                            onClick={() => setModal({ mode: 'restrict', user: u })}
                          />
                        )}
                        {can('delete_users') && canTouch(u) && !u.isAdmin && (
                          <button
                            type="button"
                            onClick={() => setModal({ mode: 'delete', user: u })}
                            disabled={busyId === u.id || isSelf}
                            title={
                              isSelf
                                ? 'Kendi hesabında işlem yapamazsın'
                                : `${u.username} hesabını komple sil (geri alınamaz)`
                            }
                            className="col-span-2 w-full rounded-lg border border-exchange-sell/60 bg-exchange-sell/10 px-2.5 py-2 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/20 active:scale-[0.98] disabled:opacity-40"
                          >
                            {busyId === u.id ? '…' : 'Hesabı Sil'}
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {/* Masaüstü: tablo (md+) */}
              {/* Uzun listeler sayfa kaymasıyla akar (iç kutu yok — mobilde
                  iç-dış kaydırma çakışması olmaz, en alttaki satıra inilir). */}
              <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[880px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-exchange-border text-[11px] uppercase tracking-wide text-exchange-muted">
                    <th scope="col" className="bg-exchange-card px-3 py-2.5 font-semibold sm:px-4">Kullanıcı</th>
                    <th scope="col" className="bg-exchange-card px-3 py-2.5 font-semibold sm:px-4">E-posta</th>
                    <th scope="col" className="bg-exchange-card px-3 py-2.5 text-right font-semibold sm:px-4">Bakiye (USDT)</th>
                    <th scope="col" className="bg-exchange-card px-3 py-2.5 font-semibold sm:px-4">Durum</th>
                    <th scope="col" className="bg-exchange-card px-3 py-2.5 text-right font-semibold sm:px-4">İşlemler</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => {
                    const isSelf = myId !== null && u.id === myId
                    return (
                      <tr key={u.id} className="border-b border-exchange-border/50 last:border-0">
                        <td className="px-3 py-2.5 sm:px-4">
                          <div className="flex min-w-0 items-center gap-2">
                            {u.avatarUrl ? (
                              <img
                                src={u.avatarUrl}
                                alt=""
                                className="h-8 w-8 shrink-0 rounded-full object-cover"
                              />
                            ) : (
                              <DefaultAvatar size="sm" />
                            )}
                            <div className="min-w-0">
                              <div className="truncate font-bold text-exchange-text">{u.username}</div>
                              {u.isAdmin ? (
                                <div className="text-[10px] font-bold uppercase tracking-wide text-exchange-yellow">
                                  Süper Admin
                                </div>
                              ) : (
                                u.permissions.length > 0 && (
                                  <div className="text-[10px] font-bold uppercase tracking-wide text-exchange-muted">
                                    Alt Yönetici
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="max-w-45 truncate px-3 py-2.5 text-exchange-muted sm:px-4">
                          {u.email || '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono font-bold text-exchange-text sm:px-4">
                          {formatNumber(u.balance, 2)}
                        </td>
                        <td className="px-3 py-2.5 sm:px-4">
                          <StatusPill user={u} />
                        </td>
                        <td className="px-3 py-2.5 sm:px-4">
                          <div className="flex justify-end gap-1.5">
                            {can('edit_balance') && canTouch(u) && (
                              <RowButton
                                label="Bakiye"
                                title={`${u.username} bakiyesini düzenle`}
                                disabled={busyId === u.id}
                                onClick={() => setModal({ mode: 'balance', user: u })}
                              />
                            )}
                            {can('ban_users') && canTouch(u) && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setModal({ mode: 'freeze', user: u })}
                                  disabled={busyId === u.id || isSelf}
                                  title={
                                    isSelf
                                      ? 'Kendi hesabında işlem yapamazsın'
                                      : u.isFrozen
                                        ? `${u.username} hesabını çöz`
                                        : `${u.username} hesabını dondur`
                                  }
                                  className={cn(
                                    'whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-40',
                                    u.isFrozen
                                      ? 'border-exchange-buy/40 text-exchange-buy hover:bg-exchange-buy/10'
                                      : 'border-exchange-sell/40 text-exchange-sell hover:bg-exchange-sell/10',
                                  )}
                                >
                                  {busyId === u.id ? '…' : u.isFrozen ? 'Çöz' : 'Dondur'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setModal({ mode: 'ban', user: u })}
                                  disabled={busyId === u.id || isSelf}
                                  title={
                                    isSelf
                                      ? 'Kendi hesabında işlem yapamazsın'
                                      : u.isBanned
                                        ? `${u.username} yasağını kaldır`
                                        : `${u.username} hesabını kalıcı yasakla`
                                  }
                                  className={cn(
                                    'whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-40',
                                    u.isBanned
                                      ? 'border-exchange-buy/40 text-exchange-buy hover:bg-exchange-buy/10'
                                      : 'border-exchange-sell/60 bg-exchange-sell/10 text-exchange-sell hover:bg-exchange-sell/20',
                                  )}
                                >
                                  {busyId === u.id ? '…' : u.isBanned ? 'Yasağı Kaldır' : 'Yasakla'}
                                </button>
                              </>
                            )}
                            {can('change_password') && u.email && canTouch(u) && (
                              <RowButton
                                label="Şifre"
                                title={`${u.username} için şifre sıfırlama e-postası gönder`}
                                disabled={busyId === u.id}
                                onClick={() => setModal({ mode: 'password', user: u })}
                              />
                            )}
                            {can('restrict_money') && canTouch(u) && (
                              <RowButton
                                label="Kısıtla"
                                title={`${u.username} için para yatırma/çekme kısıtları`}
                                disabled={busyId === u.id}
                                onClick={() => setModal({ mode: 'restrict', user: u })}
                              />
                            )}
                            {can('delete_users') && canTouch(u) && !u.isAdmin && (
                              <button
                                type="button"
                                onClick={() => setModal({ mode: 'delete', user: u })}
                                disabled={busyId === u.id || isSelf}
                                title={
                                  isSelf
                                    ? 'Kendi hesabında işlem yapamazsın'
                                    : `${u.username} hesabını komple sil (geri alınamaz)`
                                }
                                className="whitespace-nowrap rounded-lg border border-exchange-sell/60 bg-exchange-sell/10 px-2.5 py-1.5 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/20 disabled:opacity-40"
                              >
                                {busyId === u.id ? '…' : 'Sil'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </>
          )}
        </div>
        </div>

        {/* Sistem duyuruları: tüm kullanıcılara yayın (yalnızca süper admin) */}
        {showAnnounce && (
          <div
            role="tabpanel"
            aria-label="Duyurular"
            className={cn(activeTab === 'announce' ? 'block' : 'hidden')}
          >
            <AnnouncementManager />
          </div>
        )}

        {/* Bot Test Paneli: manipülasyon simülasyonu (yalnızca süper admin) */}
        {showBots && (
          <div
            role="tabpanel"
            aria-label="Botlar"
            className={cn(activeTab === 'bots' ? 'block' : 'hidden')}
          >
            <BotTestPanel />
          </div>
        )}

        {/* Coin Yönetimi: altcoin promote/demote + haberler (yalnızca süper admin) */}
        {showCoins && (
          <div
            role="tabpanel"
            aria-label="Coinler"
            className={cn(activeTab === 'coins' ? 'block' : 'hidden')}
          >
            <CoinManager />
          </div>
        )}

        {/* Etkinlik yönetimi (yalnızca süper admin) */}
        {showEvents && (
          <div
            role="tabpanel"
            aria-label="Etkinlikler"
            className={cn(activeTab === 'events' ? 'block' : 'hidden')}
          >
            <EventManager />
          </div>
        )}

        {/* Forum denetimi: tekli + toplu silme (ban yetkisi gerekir) */}
        {showForum && (
          <div
            role="tabpanel"
            aria-label="Forum"
            className={cn(activeTab === 'forum' ? 'block' : 'hidden')}
          >
            <ForumModeration isSuper={access.isSuperAdmin} />
          </div>
        )}

        {/* Yönetici yetkileri (yalnızca admin ekleyebilenler) */}
        {showAdmins && (
          <div
            role="tabpanel"
            aria-label="Yöneticiler"
            className={cn(activeTab === 'admins' ? 'block' : 'hidden')}
          >
          <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-exchange-border px-3 py-3 sm:px-4">
              <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
                Yöneticiler
                <span className="ml-2 font-mono text-xs font-semibold text-exchange-muted">
                  {admins.length}
                </span>
              </h2>
              <Button size="sm" onClick={() => setModal({ mode: 'privs', user: null })}>
                + Admin Ekle
              </Button>
            </div>
            {admins.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-exchange-muted">
                Henüz yönetici yok.
              </div>
            ) : (
              <ul>
                {admins.map((u) => {
                  const isSelf = myId !== null && u.id === myId
                  return (
                    <li
                      key={u.id}
                      className="flex flex-wrap items-center gap-2 border-b border-exchange-border/50 px-3 py-2.5 last:border-0 sm:px-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-exchange-text">
                          {u.username}
                          {isSelf && (
                            <span className="ml-2 text-[10px] font-bold uppercase text-exchange-muted">
                              (sen)
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-exchange-muted">
                          {u.isAdmin ? (
                            <span className="font-bold text-exchange-yellow">Süper Admin — tüm yetkiler</span>
                          ) : (
                            u.permissions.map((p) => permLabel(p)).join(' • ') || '—'
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        {(!u.isAdmin || access.isSuperAdmin) && (
                          <>
                            <RowButton
                              label="Düzenle"
                              title={`${u.username} yetkilerini düzenle`}
                              disabled={busyId === u.id || isSelf}
                              onClick={() => setModal({ mode: 'privs', user: u })}
                            />
                            <button
                              type="button"
                              onClick={() => setModal({ mode: 'revoke', user: u })}
                              disabled={busyId === u.id || isSelf}
                              title={isSelf ? 'Kendi yetkilerini değiştiremezsin' : 'Yöneticilikten çıkar'}
                              className="whitespace-nowrap rounded-lg border border-exchange-sell/40 px-2.5 py-1.5 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/10 disabled:opacity-40"
                            >
                              Çıkar
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          </div>
        )}

        <p className="mt-3 px-1 text-[11px] leading-relaxed text-exchange-muted">
          Bakiye değişiklikleri anında profile yansır. Dondurulan ve yasaklı hesaplar giriş yapamaz.
          Yetkisiz işlem denemeleri sunucu tarafından reddedilir. Emirler cihazda tutulur; panel
          sunucu verilerini gösterir.
        </p>
      </div>

      {modal?.mode === 'balance' && (
        <BalanceModal
          user={modal.user}
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onSave={(raw) => void saveBalance(modal.user, raw)}
        />
      )}
      {modal?.mode === 'freeze' && (
        <ConfirmModal
          title={modal.user.isFrozen ? 'Hesabı çöz' : 'Hesabı dondur'}
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onConfirm={() => void toggleFreeze(modal.user)}
          confirmLabel={modal.user.isFrozen ? 'Çöz' : 'Dondur'}
          variant={modal.user.isFrozen ? 'buy' : 'sell'}
        >
          <span className="font-bold">{modal.user.username}</span> (
          {modal.user.email || 'e-posta yok'}) hesabı{' '}
          {modal.user.isFrozen ? (
            <>
              <span className="font-bold text-exchange-buy">çözülecek</span> ve tekrar giriş
              yapabilecek.
            </>
          ) : (
            <>
              <span className="font-bold text-exchange-sell">dondurulacak</span>. Bu kullanıcı bir
              sonraki girişte engellenir.
            </>
          )}
        </ConfirmModal>
      )}
      {modal?.mode === 'ban' && (
        <ConfirmModal
          title={modal.user.isBanned ? 'Yasağı kaldır' : 'Kalıcı yasakla'}
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onConfirm={() => void toggleBan(modal.user)}
          confirmLabel={modal.user.isBanned ? 'Yasağı Kaldır' : 'Yasakla'}
          variant={modal.user.isBanned ? 'buy' : 'sell'}
        >
          <span className="font-bold">{modal.user.username}</span> (
          {modal.user.email || 'e-posta yok'}) hesabı{' '}
          {modal.user.isBanned ? (
            <>
              <span className="font-bold text-exchange-buy">yasak listesinden çıkarılacak</span> ve
              tekrar giriş yapabilecek.
            </>
          ) : (
            <>
              <span className="font-bold text-exchange-sell">kalıcı olarak yasaklanacak</span> ve
              sisteme girişi tamamen engellenecek. Bu işlem veritabanında{' '}
              <span className="font-mono">banned</span> olarak işaretlenir.
            </>
          )}
        </ConfirmModal>
      )}
      {modal?.mode === 'password' && (
        <PasswordModal
          user={modal.user}
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onConfirm={() => void resetPassword(modal.user)}
        />
      )}
      {modal?.mode === 'delete' && (
        <ConfirmModal
          title="Hesabı komple sil"
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onConfirm={() => void removeUser(modal.user)}
          confirmLabel="Evet, Komple Sil"
          variant="sell"
        >
          <span className="font-bold">{modal.user.username}</span> (
          {modal.user.email || 'e-posta yok'}) hesabı <span className="font-bold text-exchange-sell">her yerden silinecek</span>:
          bakiye, işlem geçmişi, forum yazıları ve yanıtları, sanal varlıklar, bildirimler.
          Bu işlem <span className="font-bold">geri alınamaz</span> ve kullanıcı adı
          yeniden kayda açılır.
        </ConfirmModal>
      )}
      {modal?.mode === 'restrict' && (
        <RestrictModal
          user={modal.user}
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onSave={(input) => void saveRestrictions(modal.user, input)}
        />
      )}
      {modal?.mode === 'privs' && can('manage_admins') && (
        <PrivsModal
          users={users}
          initial={modal.user}
          myId={myId}
          busyId={busyId}
          onClose={() => setModal(null)}
          onSave={(userId, isAdmin, permissions) => void savePrivs(userId, isAdmin, permissions)}
        />
      )}
      {modal?.mode === 'revoke' && (
        <ConfirmModal
          title="Yöneticilikten çıkar"
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onConfirm={() => void revokePrivs(modal.user)}
          confirmLabel="Çıkar"
          variant="sell"
        >
          <span className="font-bold">{modal.user.username}</span> yöneticilikten çıkarılacak, tüm
          yetkileri kaldırılacak ve normal kullanıcıya dönüşecek.
        </ConfirmModal>
      )}
    </div>
  )
}

function permLabel(key: string): string {
  return ADMIN_PERMISSIONS.find((p) => p.key === key)?.label ?? key
}

function RowButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="whitespace-nowrap rounded-lg border border-exchange-border px-2.5 py-1.5 text-xs font-bold text-exchange-text transition-colors hover:border-exchange-yellow hover:text-exchange-yellow disabled:opacity-40"
    >
      {label}
    </button>
  )
}

// Mobil kullanıcı kartlarındaki 2'li grid buton: tam genişlik, dokunmatik hedef.
function CardButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-lg border border-exchange-border px-2.5 py-2 text-xs font-bold text-exchange-text transition-colors hover:border-exchange-yellow hover:text-exchange-yellow active:scale-[0.98] disabled:opacity-40"
    >
      {label}
    </button>
  )
}

function StatusPill({ user }: { user: AdminUser }) {
  const banned = user.isBanned
  const frozen = user.isFrozen
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        className={cn(
          'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold',
          banned
            ? 'bg-exchange-sell/20 text-exchange-sell'
            : frozen
              ? 'bg-exchange-sell/10 text-exchange-sell'
              : 'bg-exchange-buy/10 text-exchange-buy',
        )}
      >
        {banned ? 'Yasaklı' : frozen ? 'Dondurulmuş' : 'Aktif'}
      </span>
      {user.depositBlocked && (
        <span className="inline-block whitespace-nowrap rounded-full bg-exchange-yellow/10 px-2 py-0.5 text-[10px] font-bold text-exchange-yellow">
          Yatırma Kapalı
        </span>
      )}
      {user.withdrawBlocked && (
        <span className="inline-block whitespace-nowrap rounded-full bg-exchange-yellow/10 px-2 py-0.5 text-[10px] font-bold text-exchange-yellow">
          Çekim Kapalı
        </span>
      )}
    </span>
  )
}

function AnnouncementManager() {
  const pushToast = useToastStore((s) => s.push)
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState<AnnouncementsSetupStatus | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, status] = await Promise.all([listAnnouncements(10), getAnnouncementsStatus()])
      setItems(list)
      setSetup(status)
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Duyurular yüklenemedi.', tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const publish = async () => {
    if (busy) return
    setBusy(true)
    try {
      const created = await createAnnouncement(title, body)
      setItems((list) => [created, ...list].slice(0, 10))
      setTitle('')
      setBody('')
      pushToast({ message: 'Duyuru tüm kullanıcılara yayınlandı.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Duyuru yayınlanamadı.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      await deleteAnnouncement(id)
      setItems((list) => list.filter((a) => a.id !== id))
      pushToast({ message: 'Duyuru silindi.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Duyuru silinemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <div className="border-b border-exchange-border px-3 py-3 sm:px-4">
        <h2 className="text-sm font-bold text-exchange-text">Sistem Duyurusu Yayınla</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-exchange-muted">
          Yayınlanan duyuru tüm kullanıcıların ekranında bant olarak görünür.
        </p>
        {setup === 'missing-table' && (
          <div className="mt-2 rounded-xl border border-exchange-sell/40 bg-exchange-sell/10 px-3 py-2.5 text-xs leading-relaxed text-exchange-text">
            Duyuru tablosu veritabanında yok — yayın yapılamaz. Supabase SQL
            editöründe <span className="font-mono">20260916110000_announcements</span> migration’ını
            uygulayın (veya <span className="font-mono">APPLY_ALL_PENDING.sql</span>’i çalıştırın).
          </div>
        )}
      </div>
      <div className="grid gap-2.5 border-b border-exchange-border px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <label htmlFor="announce-title" className="mb-1 block text-xs font-semibold text-exchange-muted">
            Başlık ({title.trim().length}/{ANNOUNCEMENT_TITLE_MAX})
          </label>
          <input
            id="announce-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={ANNOUNCEMENT_TITLE_MAX}
            placeholder="örn. Planlı bakım duyurusu"
            disabled={busy}
            className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="announce-body" className="mb-1 block text-xs font-semibold text-exchange-muted">
            Metin ({body.trim().length}/{ANNOUNCEMENT_BODY_MAX})
          </label>
          <textarea
            id="announce-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={ANNOUNCEMENT_BODY_MAX}
            rows={3}
            placeholder="Duyuru metnini yaz…"
            disabled={busy}
            className="w-full min-w-0 resize-y rounded-xl border border-exchange-border bg-exchange-bg px-3 py-2.5 text-sm leading-relaxed text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
          />
        </div>
        <div>
          <Button size="sm" onClick={() => void publish()} disabled={busy || !title.trim() || !body.trim()}>
            {busy ? 'Yayınlanıyor…' : 'Tüm Kullanıcılara Yayınla'}
          </Button>
        </div>
      </div>
      {loading && items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-exchange-muted">
          Duyurular yükleniyor…
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-exchange-muted">
          Henüz yayınlanmış duyuru yok.
        </div>
      ) : (
        <ul>
          {items.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-2 border-b border-exchange-border/50 px-3 py-2.5 last:border-0 sm:px-4"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold text-exchange-text">{a.title}</div>
                <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-exchange-muted">
                  {a.body}
                </p>
                {a.createdAt > 0 && (
                  <div className="mt-0.5 font-mono text-[10px] text-exchange-muted">
                    {new Date(a.createdAt).toLocaleString('tr-TR')}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void remove(a.id)}
                disabled={busy}
                aria-label={`${a.title} duyurusunu sil`}
                className="shrink-0 whitespace-nowrap rounded-lg border border-exchange-sell/40 px-2.5 py-1.5 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/10 disabled:opacity-40"
              >
                Sil
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function BotTestPanel() {
  const pushToast = useToastStore((s) => s.push)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [coins, setCoins] = useState<string[]>([])
  const [targets, setTargets] = useState<Record<string, string>>({})

  // Hedef listesi: tüm sanal coinler + emtialar (kripto/emtia ayrımıyla).
  useEffect(() => {
    let live = true
    void listVirtualCoins()
      .then((list) => {
        if (!live) return
        const syms = list.map((c) => c.symbol.toUpperCase())
        setCoins(syms)
        setTargets((prev) => {
          const next = { ...prev }
          for (const b of CHARACTER_BOTS) {
            if (!next[b.id]) next[b.id] = b.defaultCoin
          }
          return next
        })
      })
      .catch(() => {
        if (live) setCoins([])
      })
    return () => {
      live = false
    }
  }, [])

  const run = async (botId: string, botName: string, symbol: string, direction: 'up' | 'down') => {
    const key = `${botId}:${symbol}:${direction}`
    if (busyKey) return
    setBusyKey(key)
    try {
      const res = await runCharacterBot(botId, symbol, direction)
      pushToast({ message: `${botName}: ${res.summary}`, tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : `${botName} çalıştırılamadı.`, tone: 'error' })
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <div className="border-b border-exchange-border px-3 py-3 sm:px-4">
        <h2 className="text-sm font-bold text-exchange-text">Bot Test Paneli</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-exchange-muted">
          Karakter botu + hedef coin/emtia seç → Yükselt veya Düşür. Bot foruma
          personaya uygun mesaj düşüp havuzda hamle yapar; fiyat, grafik ve
          piyasa listesi gerçek takastaki gibi güncellenir. Bakiyelere dokunulmaz.
        </p>
      </div>
      <ul>
        {CHARACTER_BOTS.map((b) => (
          <li
            key={b.id}
            className="border-b border-exchange-border/50 px-3 py-3 last:border-0 sm:px-4"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-exchange-text">{b.name}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-exchange-muted">
                {b.description}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <select
                value={targets[b.id] ?? b.defaultCoin}
                onChange={(e) => setTargets((prev) => ({ ...prev, [b.id]: e.target.value }))}
                aria-label={`${b.name} hedef coin`}
                disabled={busyKey !== null}
                className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-exchange-border bg-exchange-bg px-2 font-mono text-xs font-bold text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 sm:max-w-44"
              >
                {coins.length === 0 && (
                  <option value={b.defaultCoin}>{b.defaultCoin}</option>
                )}
                {coins.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="buy"
                onClick={() => void run(b.id, b.name, targets[b.id] ?? b.defaultCoin, 'up')}
                disabled={busyKey !== null}
                className="shrink-0 whitespace-nowrap"
              >
                {busyKey === `${b.id}:${targets[b.id] ?? b.defaultCoin}:up` ? '…' : 'Yükselt'}
              </Button>
              <Button
                size="sm"
                variant="sell"
                onClick={() => void run(b.id, b.name, targets[b.id] ?? b.defaultCoin, 'down')}
                disabled={busyKey !== null || b.tradeUsdt <= 0}
                title={b.tradeUsdt <= 0 ? 'Bu bot piyasaya etki etmez (yalnızca mesaj)' : undefined}
                className="shrink-0 whitespace-nowrap"
              >
                {busyKey === `${b.id}:${targets[b.id] ?? b.defaultCoin}:down` ? '…' : 'Düşür'}
              </Button>
              {b.tradeUsdt <= 0 && (
                <Button
                  size="sm"
                  onClick={() => void run(b.id, b.name, targets[b.id] ?? b.defaultCoin, 'up')}
                  disabled={busyKey !== null}
                  className="shrink-0 whitespace-nowrap"
                >
                  {busyKey ? '…' : 'Mesaj Gönder'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CoinManager() {
  const pushToast = useToastStore((s) => s.push)
  const [coins, setCoins] = useState<VirtualCoin[]>([])
  const [loading, setLoading] = useState(true)
  const [busySymbol, setBusySymbol] = useState<string | null>(null)
  const [expandedCoin, setExpandedCoin] = useState<string | null>(null)
  const [coinNews, setCoinNews] = useState<Record<string, CoinNewsItem[]>>({})
  const [newsLoading, setNewsLoading] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Record<string, CoinStatus>>({})
  const [newSymbol, setNewSymbol] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [virtual, rows] = await Promise.all([listVirtualCoins(), listCoinOverrides()])
      setCoins(virtual)
      setOverrides(Object.fromEntries(rows.map((r) => [r.symbol, r.status])))
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Coinler yüklenemedi.', tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const loadNews = useCallback(async (symbol: string) => {
    setNewsLoading((prev) => new Set([...prev, symbol]))
    try {
      const news = await listCoinNews(symbol)
      setCoinNews((prev) => ({ ...prev, [symbol]: news }))
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Haberler yüklenemedi.', tone: 'error' })
    } finally {
      setNewsLoading((prev) => {
        const next = new Set(prev)
        next.delete(symbol)
        return next
      })
    }
  }, [pushToast])

  const handleExpand = (symbol: string) => {
    setExpandedCoin((prev) => {
      if (prev === symbol) return null
      void loadNews(symbol)
      return symbol
    })
  }

  /** Efektif durum: override varsa o, yoksa sanal havuz satırı. */
  const effectiveStatus = useCallback(
    (symbol: string, fallback: CoinStatus = 'normal'): CoinStatus =>
      overrides[symbol.toUpperCase()] ?? fallback,
    [overrides],
  )

  const applyStatusResult = useCallback((symbol: string, status: CoinStatus) => {
    const key = symbol.toUpperCase()
    setOverrides((prev) => ({ ...prev, [key]: status }))
    setCoins((list) => list.map((c) => (c.symbol === key ? { ...c, status } : c)))
  }, [])

  const [pumpModal, setPumpModal] = useState<{
    symbol: string
    direction: PumpDirection
    virtual: boolean
  } | null>(null)

  /**
   * Haberle Yükselt / Düşür: önce haber girilir → panele + foruma yayınlanır →
   * fiyat hedef etki kadar oynar (varsayılan %1.8, admin belirler;
   * yalnızca sanal havuzda; gerçek sembolde fiyat adımı yok).
   */
  const runPump = async (
    symbol: string,
    direction: PumpDirection,
    title: string,
    body: string,
    effectPct: number,
  ) => {
    if (busySymbol) return
    setBusySymbol(symbol)
    try {
      const res = await pumpCoinWithNews(
        symbol,
        direction,
        title,
        body,
        effectiveStatus(symbol, coins.find((c) => c.symbol === symbol.toUpperCase())?.status ?? 'normal'),
        effectPct,
      )
      applyStatusResult(res.symbol, effectiveStatus(symbol))
      pushToast({ message: res.summary, tone: 'success' })
      setPumpModal(null)
      void loadNews(symbol.toUpperCase())
      // Havuz fiyatı değişti — listeyi tazele.
      void load()
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'İşlem yapılamadı.', tone: 'error' })
    } finally {
      setBusySymbol(null)
    }
  }

  /** Listede olmayan herhangi bir sembolü yönetime ekle (örn. BTCUSDT). */
  const addSymbol = async () => {
    const clean = newSymbol.trim().toUpperCase()
    if (!clean || busySymbol) return
    setBusySymbol(clean)
    try {
      const res = await updateCoinStatus(clean, 'normal')
      applyStatusResult(res.coin.symbol || clean, res.coin.status)
      setNewSymbol('')
      setExpandedCoin(clean)
      void loadNews(clean)
      pushToast({ message: `${clean} yönetime eklendi.`, tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Sembol eklenemedi.', tone: 'error' })
    } finally {
      setBusySymbol(null)
    }
  }

  const handleDeleteNews = async (newsId: string, symbol: string) => {
    if (busySymbol) return
    setBusySymbol(symbol)
    try {
      await deleteCoinNews(newsId)
      pushToast({ message: 'Haber silindi.', tone: 'success' })
      void loadNews(symbol)
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Haber silinemedi.', tone: 'error' })
    } finally {
      setBusySymbol(null)
    }
  }

  if (loading && coins.length === 0) {
    return (
      <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
        <div className="px-3 py-8 text-center text-sm text-exchange-muted">Coinler yükleniyor…</div>
      </div>
    )
  }

  // Birleştirilmiş satırlar: sanal coinler (kripto + emtia aynen) ile
  // yalnızca kaydı olan piyasa sembolleri (örn. BTCUSDT).
  const virtualKeys = new Set(coins.map((c) => c.symbol.toUpperCase()))
  const extraSymbols = Object.keys(overrides).filter((s) => !virtualKeys.has(s)).sort()
  const rows: {
    symbol: string
    name: string
    kind: 'crypto' | 'commodity' | null
    detail: string | null
    virtual: boolean
  }[] = [
    ...coins.map((c) => ({
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      kind: c.type as 'crypto' | 'commodity',
      detail: `Fiyat: ${c.currentPrice.toFixed(c.currentPrice < 1 ? 6 : 4)} | Havuz: ${c.reserveUsdt.toLocaleString()} USDT`,
      virtual: true,
    })),
    ...extraSymbols.map((s) => ({
      symbol: s,
      name: 'Piyasa sembolü',
      kind: null,
      detail: null,
      virtual: false,
    })),
  ]

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <div className="border-b border-exchange-border px-3 py-3 sm:px-4">
        <h2 className="text-sm font-bold text-exchange-text">Coin Yönetimi</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-exchange-muted">
          Satıra dokun → menü açılır → Haberi gir + etkiyi seç → forumda
          yayınlansın → fiyat oynasın. Fiyat adımı yalnızca sanal havuzlarda
          işler; gerçek piyasa coinlerinde haber + forum yayınlanır.
        </p>
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <input
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addSymbol()
            }}
            placeholder="Sembol ekle… (örn. BTCUSDT)"
            aria-label="Yönetime sembol ekle"
            disabled={busySymbol !== null}
            className="h-9 min-w-0 flex-1 rounded-lg border border-exchange-border bg-exchange-bg px-3 font-mono text-xs text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70 sm:max-w-60"
          />
          <Button size="sm" onClick={() => void addSymbol()} disabled={busySymbol !== null || !newSymbol.trim()}>
            {busySymbol ? '…' : '+ Ekle'}
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-exchange-muted">Henüz coin tanımlı değil.</div>
      ) : (
        <ul>
          {rows.map((coin) => {
            const open = expandedCoin === coin.symbol
            return (
              <li key={coin.symbol} className="border-b border-exchange-border/50 last:border-0">
                {/* Açılır satır başlığı: mobilde tek satır, ekran verimli kullanılır */}
                <button
                  type="button"
                  onClick={() => handleExpand(coin.symbol)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 px-3 py-3 text-left transition-colors active:scale-[0.99] sm:px-4"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-bold text-exchange-text">{coin.symbol}</span>
                      <span className="truncate text-xs text-exchange-muted">{coin.name}</span>
                      {coin.kind && (
                        <span className="shrink-0 rounded-full bg-exchange-border/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-exchange-muted">
                          {coin.kind === 'crypto' ? 'Kripto' : 'Emtia'}
                        </span>
                      )}
                    </span>
                    {coin.detail && (
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-exchange-muted">
                        {coin.detail}
                      </span>
                    )}
                  </span>
                  <span
                    aria-hidden
                    className={cn('shrink-0 text-[11px] text-exchange-muted transition-transform', open && 'rotate-180')}
                  >
                    ▼
                  </span>
                </button>
                {open && (
                  <div className="space-y-2.5 border-t border-exchange-border/40 bg-exchange-bg/40 px-3 py-3 sm:px-4">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="buy"
                        onClick={() =>
                          setPumpModal({ symbol: coin.symbol, direction: 'up', virtual: coin.virtual })
                        }
                        disabled={busySymbol !== null}
                        className="min-w-0 flex-1 whitespace-nowrap sm:flex-none"
                      >
                        {busySymbol === coin.symbol ? '…' : 'Haberle Yükselt'}
                      </Button>
                      <Button
                        size="sm"
                        variant="sell"
                        onClick={() =>
                          setPumpModal({ symbol: coin.symbol, direction: 'down', virtual: coin.virtual })
                        }
                        disabled={busySymbol !== null}
                        className="min-w-0 flex-1 whitespace-nowrap sm:flex-none"
                      >
                        {busySymbol === coin.symbol ? '…' : 'Haberle Düşür'}
                      </Button>
                    </div>
                    <div>
                      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-exchange-muted">
                        Haberler
                      </div>
                      {newsLoading.has(coin.symbol) ? (
                        <div className="text-xs text-exchange-muted">Haberler yükleniyor…</div>
                      ) : coinNews[coin.symbol]?.length === 0 ? (
                        <div className="text-xs font-bold text-exchange-muted">Bu coin için henüz haber yok.</div>
                      ) : (
                        <div className="space-y-2">
                          {coinNews[coin.symbol]!.map((news) => (
                            <div
                              key={news.id}
                              className="rounded-xl border border-exchange-border/30 bg-exchange-bg/50 p-2.5"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-bold text-exchange-text">{news.title}</div>
                                  <div className="mt-1 break-words text-xs leading-relaxed text-exchange-muted">{news.body}</div>
                                  <div className="mt-1 font-mono text-[10px] text-exchange-muted">
                                    {new Date(news.createdAt).toLocaleString('tr-TR')}
                                  </div>
                                </div>
                                <Button
                                  size="sm"
                                  variant="sell"
                                  onClick={() => void handleDeleteNews(news.id, coin.symbol)}
                                  disabled={busySymbol !== null}
                                  className="shrink-0 whitespace-nowrap"
                                >
                                  Sil
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {pumpModal && (
        <NewsPumpModal
          symbol={pumpModal.symbol}
          direction={pumpModal.direction}
          virtual={pumpModal.virtual}
          busy={busySymbol === pumpModal.symbol}
          onClose={() => setPumpModal(null)}
          onConfirm={(title, body, effectPct) => void runPump(pumpModal.symbol, pumpModal.direction, title, body, effectPct)}
        />
      )}
    </div>
  )
}

function NewsPumpModal({
  symbol,
  direction,
  virtual,
  busy,
  onClose,
  onConfirm,
}: {
  symbol: string
  direction: PumpDirection
  virtual: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (title: string, body: string, effectPct: number) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [effectStr, setEffectStr] = useState(String(NEWS_PUMP_TARGET_PCT))
  const up = direction === 'up'
  const parsed = Number(String(effectStr).replace(',', '.'))
  const effectPct = Number.isFinite(parsed) && parsed > 0 && parsed < 20 ? parsed : NEWS_PUMP_TARGET_PCT
  const effectValid = Number.isFinite(parsed) && parsed > 0 && parsed < 20
  return (
    <ModalShell title={`${up ? 'Haberle Yükselt' : 'Haberle Düşür'} — ${symbol}`} onClose={onClose}>
      <p className="text-xs leading-relaxed text-exchange-muted">
        Önce haber girilir → forumda yayınlanır → fiyat %{effectValid ? String(effectStr).replace('.', ',') : '…'} {up ? 'yükselir' : 'düşer'}.
        {!virtual && ' Bu sembol gerçek piyasa coini — fiyat adımı atlanır, yalnızca haber + forum yayınlanır.'}
      </p>
      {virtual && (
        <div className="mt-3 min-w-0">
          <label htmlFor="pump-effect" className="block text-xs font-semibold text-exchange-muted">
            Etki (%) — 0,1 ile 20 arası, ondalık virgül/nokta olur
          </label>
          <input
            id="pump-effect"
            value={effectStr}
            onChange={(e) => setEffectStr(e.target.value)}
            inputMode="decimal"
            placeholder="1.8"
            disabled={busy}
            aria-invalid={!effectValid}
            className="mt-1.5 h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
          />
          {!effectValid && (
            <p className="mt-1 text-[11px] font-semibold text-exchange-sell">
              0,1 – 20 arasında bir yüzde gir (örn. 1.8).
            </p>
          )}
        </div>
      )}
      <label htmlFor="pump-news-title" className="mt-3 block text-xs font-semibold text-exchange-muted">
        Haber başlığı ({title.trim().length}/{NEWS_TITLE_MAX})
      </label>
      <input
        id="pump-news-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={NEWS_TITLE_MAX}
        placeholder="örn. Dev ortaklık duyurusu"
        disabled={busy}
        className="mt-1.5 h-11 w-full rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
      />
      <label htmlFor="pump-news-body" className="mt-3 block text-xs font-semibold text-exchange-muted">
        Haber metni ({body.trim().length}/{NEWS_BODY_MAX})
      </label>
      <textarea
        id="pump-news-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={NEWS_BODY_MAX}
        rows={4}
        placeholder="Haber metnini yaz…"
        disabled={busy}
        className="mt-1.5 w-full resize-y rounded-xl border border-exchange-border bg-exchange-bg px-3 py-2.5 text-sm leading-relaxed text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          variant={up ? 'buy' : 'sell'}
          onClick={() => onConfirm(title, body, effectPct)}
          disabled={busy || !title.trim() || !body.trim() || !effectValid}
        >
          {busy ? 'Yayınlanıyor…' : up ? 'Yükselt + Yayınla' : 'Düşür + Yayınla'}
        </Button>
      </div>
    </ModalShell>
  )
}

/** Tarih damgasını `datetime-local` girdi formatına çevirir. */
function toLocalInput(value: number | null): string {
  if (!value) return ''
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function EventManager() {
  const pushToast = useToastStore((s) => s.push)
  const [items, setItems] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [isActive, setIsActive] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await listEvents(50))
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Etkinlikler yüklenemedi.', tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const resetForm = () => {
    setEditingId(null)
    setTitle('')
    setBody('')
    setStartsAt('')
    setEndsAt('')
    setIsActive(true)
  }

  const startEdit = (e: EventItem) => {
    setEditingId(e.id)
    setTitle(e.title)
    setBody(e.body)
    setStartsAt(toLocalInput(e.startsAt))
    setEndsAt(toLocalInput(e.endsAt))
    setIsActive(e.isActive)
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const input: EventInput = { title, body, startsAt, endsAt, isActive }
      await saveEvent(editingId, input)
      pushToast({
        message: editingId ? 'Etkinlik güncellendi.' : 'Etkinlik yayınlandı.',
        tone: 'success',
      })
      resetForm()
      await load()
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Etkinlik kaydedilemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string, eventTitle: string) => {
    if (busy) return
    if (!window.confirm(`"${eventTitle}" silinsin mi?`)) return
    setBusy(true)
    try {
      await deleteEvent(id)
      if (editingId === id) resetForm()
      pushToast({ message: 'Etkinlik silindi.', tone: 'success' })
      await load()
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Etkinlik silinemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (e: EventItem) => {
    if (busy) return
    setBusy(true)
    try {
      await saveEvent(e.id, {
        title: e.title,
        body: e.body,
        startsAt: toLocalInput(e.startsAt),
        endsAt: toLocalInput(e.endsAt),
        isActive: !e.isActive,
      })
      pushToast({
        message: e.isActive ? 'Etkinlik pasife alındı.' : 'Etkinlik aktife alındı.',
        tone: 'success',
      })
      await load()
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Durum değiştirilemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <div className="border-b border-exchange-border px-3 py-3 sm:px-4">
        <h2 className="text-sm font-bold text-exchange-text">
          {editingId ? 'Etkinliği Düzenle' : 'Yeni Etkinlik'}
        </h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-exchange-muted">
          Yayınlanan etkinlik menüdeki Etkinlik sekmesinde görünür.
        </p>
      </div>
      <div className="grid gap-2.5 border-b border-exchange-border px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <label htmlFor="event-title" className="mb-1 block text-xs font-semibold text-exchange-muted">
            Başlık ({title.trim().length}/{EVENT_TITLE_MAX})
          </label>
          <input
            id="event-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={EVENT_TITLE_MAX}
            placeholder="örn. Haftalık işlem yarışması"
            disabled={busy}
            className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="event-body" className="mb-1 block text-xs font-semibold text-exchange-muted">
            Metin ({body.trim().length}/{EVENT_BODY_MAX})
          </label>
          <textarea
            id="event-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={EVENT_BODY_MAX}
            rows={3}
            placeholder="Etkinlik detaylarını yaz…"
            disabled={busy}
            className="w-full min-w-0 resize-y rounded-xl border border-exchange-border bg-exchange-bg px-3 py-2.5 text-sm leading-relaxed text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
          />
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="event-starts" className="mb-1 block text-xs font-semibold text-exchange-muted">
              Başlangıç (opsiyonel)
            </label>
            <input
              id="event-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              disabled={busy}
              className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="event-ends" className="mb-1 block text-xs font-semibold text-exchange-muted">
              Bitiş (opsiyonel)
            </label>
            <input
              id="event-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              disabled={busy}
              className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50"
            />
          </div>
        </div>
        <label
          className={cn(
            'flex min-w-0 cursor-pointer items-center gap-2 text-xs font-semibold text-exchange-text',
            busy && 'pointer-events-none opacity-50',
          )}
        >
          <Toggle checked={isActive} onChange={setIsActive} />
          Aktif olarak yayınla
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy || !title.trim() || !body.trim()}>
            {busy ? 'Kaydediliyor…' : editingId ? 'Güncelle' : 'Yayınla'}
          </Button>
          {editingId && (
            <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy}>
              Vazgeç
            </Button>
          )}
        </div>
      </div>
      {loading && items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-exchange-muted">
          Etkinlikler yükleniyor…
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-exchange-muted">
          Henüz etkinlik girilmedi.
        </div>
      ) : (
        <ul>
          {items.map((e) => (
            <li
              key={e.id}
              className="flex items-start gap-2 border-b border-exchange-border/50 px-3 py-2.5 last:border-0 sm:px-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
                    {e.title}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide',
                      e.isActive
                        ? 'bg-exchange-buy/15 text-exchange-buy'
                        : 'bg-exchange-border/40 text-exchange-muted',
                    )}
                  >
                    {e.isActive ? 'Aktif' : 'Pasif'}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-exchange-muted">
                  {e.body}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void toggleActive(e)}
                  disabled={busy}
                  className="whitespace-nowrap rounded-lg border border-exchange-border px-2.5 py-1.5 text-xs font-bold text-exchange-text transition-colors hover:border-exchange-yellow hover:text-exchange-yellow disabled:opacity-40"
                >
                  {e.isActive ? 'Pasife Al' : 'Aktife Al'}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(e)}
                  disabled={busy}
                  className="whitespace-nowrap rounded-lg border border-exchange-border px-2.5 py-1.5 text-xs font-bold text-exchange-text transition-colors hover:border-exchange-yellow hover:text-exchange-yellow disabled:opacity-40"
                >
                  Düzenle
                </button>
                <button
                  type="button"
                  onClick={() => void remove(e.id, e.title)}
                  disabled={busy}
                  aria-label={`${e.title} etkinliğini sil`}
                  className="whitespace-nowrap rounded-lg border border-exchange-sell/40 px-2.5 py-1.5 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/10 disabled:opacity-40"
                >
                  Sil
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ForumModeration({ isSuper }: { isSuper: boolean }) {
  const pushToast = useToastStore((s) => s.push)
  const [posts, setPosts] = useState<AdminForumPost[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPosts(await listForumAdminPosts(50))
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Forum yazıları yüklenemedi.', tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Korumalı (süper admin) satırlar toplu seçime girmez.
  const touchableIds = posts.filter((p) => isSuper || !p.authorIsAdmin).map((p) => p.id)

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === touchableIds.length && touchableIds.length > 0
        ? new Set<string>()
        : new Set<string>(touchableIds),
    )
  }

  const removeMany = async (ids: string[]) => {
    if (ids.length === 0 || busy) return
    setBusy(true)
    try {
      const { deleted, failed } = await deleteForumPostsBulk(ids)
      setPosts((list) => list.filter((p) => !ids.includes(p.id)))
      setSelected(new Set())
      setConfirmIds(null)
      if (deleted > 0) {
        pushToast({
          message:
            failed > 0
              ? `${deleted} gönderi silindi, ${failed} tanesi silinemedi.`
              : `${deleted} gönderi silindi.`,
          tone: failed > 0 ? 'error' : 'success',
        })
      } else {
        pushToast({ message: 'Hiçbir gönderi silinemedi.', tone: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-exchange-border px-3 py-3 sm:px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
          Forum Denetimi
          <span className="ml-2 font-mono text-xs font-semibold text-exchange-muted">
            son {posts.length}
          </span>
        </h2>
        {selected.size > 0 && (
          <Button
            size="sm"
            variant="sell"
            disabled={busy}
            onClick={() => setConfirmIds([...selected])}
          >
            Seçilenleri Sil ({selected.size})
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? 'Yükleniyor…' : 'Yenile'}
        </Button>
      </div>

      {loading && posts.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-exchange-muted">
          Forum yazıları yükleniyor…
        </div>
      ) : posts.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-exchange-muted">
          Silinecek yazı yok.
        </div>
      ) : (
        <div>
          <ul>
            <li className="flex items-center gap-2 border-b border-exchange-border bg-exchange-card px-3 py-2 sm:px-4">
              <input
                type="checkbox"
                checked={touchableIds.length > 0 && selected.size === touchableIds.length}
                onChange={toggleAll}
                aria-label="Tümünü seç"
                className="h-4 w-4 shrink-0 accent-yellow-400"
              />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-exchange-muted">
                Tümünü seç
              </span>
            </li>
            {posts.map((p) => {
              // Süper admin yazılarına yalnız süper admin dokunur.
              const locked = !isSuper && p.authorIsAdmin
              return (
              <li
                key={p.id}
                className="flex items-start gap-2 border-b border-exchange-border/50 px-3 py-2.5 last:border-0 sm:px-4"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  disabled={locked}
                  aria-label={`${p.username} gönderisini seç`}
                  className="mt-1 h-4 w-4 shrink-0 accent-yellow-400 disabled:opacity-40"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-xs font-bold text-exchange-text">
                      {p.username}
                    </span>
                    {locked && (
                      <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-exchange-muted">
                        korumalı
                      </span>
                    )}
                    <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-exchange-muted">
                      {p.likeCount} beğeni · {p.replyCount} yanıt
                      {p.createdAt > 0 ? ` · ${new Date(p.createdAt).toLocaleString('tr-TR')}` : ''}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-exchange-muted">
                    {p.content}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmIds([p.id])}
                  disabled={busy || locked}
                  title={locked ? 'Süper admin yazısına müdahale edemezsin' : `${p.username} gönderisini sil`}
                  aria-label={`${p.username} gönderisini sil`}
                  className="shrink-0 whitespace-nowrap rounded-lg border border-exchange-sell/40 px-2.5 py-1.5 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/10 disabled:opacity-40"
                >
                  Sil
                </button>
              </li>
              )
            })}
          </ul>
        </div>
      )}

      {confirmIds && (
        <ConfirmModal
          title={confirmIds.length > 1 ? 'Toplu silme onayı' : 'Gönderiyi sil'}
          busy={busy}
          onClose={() => setConfirmIds(null)}
          onConfirm={() => void removeMany(confirmIds)}
          confirmLabel={confirmIds.length > 1 ? `${confirmIds.length} Gönderiyi Sil` : 'Sil'}
          variant="sell"
        >
          {confirmIds.length > 1 ? (
            <>
              <span className="font-bold">{confirmIds.length} gönderi</span> ve altındaki tüm
              yanıtlar kalıcı olarak silinecek. Bu işlem geri alınamaz.
            </>
          ) : (
            <>
              Bu gönderi ve altındaki tüm yanıtlar kalıcı olarak silinecek. Bu işlem geri
              alınamaz.
            </>
          )}
        </ConfirmModal>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string
  value: string
  icon: React.ReactNode
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-exchange-border bg-exchange-card px-3 py-3 sm:px-4 sm:py-4',
        accent && 'border-exchange-yellow/30',
      )}
    >
      <div className="flex items-center gap-2 text-exchange-muted">
        <span className={cn(accent ? 'text-exchange-yellow' : 'text-exchange-muted')} aria-hidden>
          {icon}
        </span>
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-1.5 truncate font-mono text-lg font-extrabold text-exchange-text sm:text-xl">
        {value}
      </div>
    </div>
  )
}

function BalanceModal({
  user,
  busy,
  onClose,
  onSave,
}: {
  user: AdminUser
  busy: boolean
  onClose: () => void
  onSave: (raw: string) => void
}) {
  const [raw, setRaw] = useState(String(user.balance))
  const bump = (delta: number) => {
    const current = Number(raw.replace(',', '.'))
    const base = Number.isFinite(current) ? current : user.balance
    setRaw(String(Math.max(0, Math.round((base + delta) * 100) / 100)))
  }
  return (
    <ModalShell title="Bakiye güncelle" onClose={onClose}>
      <p className="text-sm text-exchange-muted">
        <span className="font-bold text-exchange-text">{user.username}</span> — mevcut bakiye{' '}
        <span className="font-mono font-bold text-exchange-text">{formatNumber(user.balance, 2)} USDT</span>
      </p>
      <label htmlFor="admin-balance-input" className="mt-3 block text-xs font-semibold text-exchange-muted">
        Yeni bakiye (USDT)
      </label>
      <input
        id="admin-balance-input"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        inputMode="decimal"
        placeholder="0.00"
        className="mt-1.5 h-11 w-full rounded-xl border border-exchange-border bg-exchange-bg px-3 font-mono text-base text-exchange-text outline-none focus:border-exchange-yellow"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {[-1000, -100, 100, 1000].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => bump(d)}
            className="rounded-full border border-exchange-border px-2.5 py-1 font-mono text-xs font-bold text-exchange-muted transition-colors hover:border-exchange-yellow hover:text-exchange-yellow"
          >
            {d > 0 ? `+${d}` : d}
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button size="sm" onClick={() => onSave(raw)} disabled={busy}>
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </Button>
      </div>
    </ModalShell>
  )
}

function ConfirmModal({
  title,
  busy,
  onClose,
  onConfirm,
  confirmLabel,
  variant,
  children,
}: {
  title: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
  confirmLabel: string
  variant: 'sell' | 'buy'
  children: React.ReactNode
}) {
  return (
    <ModalShell title={title} onClose={onClose}>
      <p className="text-sm leading-relaxed text-exchange-text">{children}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button size="sm" variant={variant} onClick={onConfirm} disabled={busy}>
          {busy ? 'İşleniyor…' : confirmLabel}
        </Button>
      </div>
    </ModalShell>
  )
}

function PasswordModal({
  user,
  busy,
  onClose,
  onConfirm,
}: {
  user: AdminUser
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <ModalShell title="Şifre sıfırla" onClose={onClose}>
      <p className="text-sm leading-relaxed text-exchange-text">
        <span className="font-bold">{user.username}</span> ({user.email}) adresine şifre sıfırlama
        bağlantısı gönderilecek. Kullanıcı e-postadaki bağlantıyla kendi şifresini belirler —{' '}
        <span className="font-bold">şifreyi kimse göremez</span>, yönetici dahil.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Gönderiliyor…' : 'Sıfırlama E-postası Gönder'}
        </Button>
      </div>
    </ModalShell>
  )
}

function RestrictModal({
  user,
  busy,
  onClose,
  onSave,
}: {
  user: AdminUser
  busy: boolean
  onClose: () => void
  onSave: (input: { depositBlocked: boolean; withdrawBlocked: boolean }) => void
}) {
  const [depositBlocked, setDepositBlocked] = useState(user.depositBlocked)
  const [withdrawBlocked, setWithdrawBlocked] = useState(user.withdrawBlocked)
  return (
    <ModalShell title="Para kısıtları" onClose={onClose}>
      <p className="text-sm text-exchange-muted">
        <span className="font-bold text-exchange-text">{user.username}</span> hesabı giriş yapmaya
        ve işlem yapmaya devam eder; yalnızca seçili para yönleri kapatılır.
      </p>
      <div className="mt-3 grid gap-2">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-exchange-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-bold text-exchange-text">Para yatırma</div>
            <div className="text-[11px] text-exchange-muted">
              {depositBlocked ? 'Kapalı — kullanıcı bakiye yükleyemez' : 'Açık'}
            </div>
          </div>
          <Toggle
            checked={!depositBlocked}
            onChange={(open) => setDepositBlocked(!open)}
            label="Para yatırma izni"
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-exchange-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-bold text-exchange-text">Para çekme</div>
            <div className="text-[11px] text-exchange-muted">
              {withdrawBlocked ? 'Kapalı — kullanıcı bakiye çekemez' : 'Açık'}
            </div>
          </div>
          <Toggle
            checked={!withdrawBlocked}
            onChange={(open) => setWithdrawBlocked(!open)}
            label="Para çekme izni"
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          onClick={() => onSave({ depositBlocked, withdrawBlocked })}
          disabled={busy}
        >
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </Button>
      </div>
    </ModalShell>
  )
}

function PrivsModal({
  users,
  initial,
  myId,
  busyId,
  onClose,
  onSave,
}: {
  users: AdminUser[]
  initial: AdminUser | null
  myId: string | null
  busyId: string | null
  onClose: () => void
  onSave: (userId: string, isAdmin: boolean, permissions: AdminPermission[]) => void
}) {
  const [text, setText] = useState(initial?.username ?? '')
  const [pickedId, setPickedId] = useState(initial?.id ?? '')
  const [isSuper, setIsSuper] = useState(initial?.isAdmin ?? false)
  const [checked, setChecked] = useState<AdminPermission[]>(initial?.permissions ?? [])
  // Seçim yalnızca tam eşleşmede kurulur; serbest yazım input'u silmez.
  const picked =
    users.find((u) => u.id === pickedId) ??
    users.find(
      (u) =>
        u.username.toLowerCase() === text.trim().toLowerCase() ||
        u.email.toLowerCase() === text.trim().toLowerCase(),
    ) ??
    null
  const effectiveId = picked?.id ?? ''
  const isSelf = myId !== null && effectiveId !== '' && effectiveId === myId
  const busy = effectiveId !== '' && busyId === effectiveId

  const toggle = (key: AdminPermission) => {
    setChecked((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]))
  }

  const canSave = picked !== null && !isSelf && !busy && (isSuper || checked.length > 0)

  return (
    <ModalShell title={initial ? 'Yetkileri düzenle' : 'Admin ekle'} onClose={onClose}>
      {!initial && (
        <>
          <label htmlFor="admin-user-pick" className="block text-xs font-semibold text-exchange-muted">
            Kullanıcı seç
          </label>
          <input
            id="admin-user-pick"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              const q = e.target.value.trim().toLowerCase()
              const found =
                users.find((u) => u.username.toLowerCase() === q || u.email.toLowerCase() === q) ??
                null
              setPickedId(found?.id ?? '')
            }}
            list="admin-user-list"
            placeholder="Kullanıcı adı veya e-posta yaz…"
            autoComplete="off"
            className="mt-1.5 h-11 w-full rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/70"
          />
          <datalist id="admin-user-list">
            {users.map((u) => (
              <option key={u.id} value={u.username}>
                {u.email}
              </option>
            ))}
          </datalist>
          {picked && (
            <p className="mt-1.5 text-xs text-exchange-muted">
              Seçili: <span className="font-bold text-exchange-text">{picked.username}</span> ({picked.email || 'e-posta yok'})
            </p>
          )}
        </>
      )}
      {initial && (
        <p className="text-sm text-exchange-muted">
          <span className="font-bold text-exchange-text">{initial.username}</span> ({initial.email || 'e-posta yok'})
        </p>
      )}

      <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-xl border border-exchange-yellow/30 bg-exchange-yellow/5 px-3 py-2.5">
        <input
          type="checkbox"
          checked={isSuper}
          onChange={(e) => setIsSuper(e.target.checked)}
          disabled={isSelf}
          className="h-4 w-4 accent-yellow-400"
        />
        <span className="text-sm font-bold text-exchange-text">
          Süper Admin <span className="font-normal text-exchange-muted">(tüm yetkiler)</span>
        </span>
      </label>

      <fieldset className="mt-3" disabled={isSuper || isSelf}>
        <legend className="px-1 text-xs font-semibold text-exchange-muted">
          Alt yönetici yetkileri
        </legend>
        <div className="mt-1.5 grid gap-1.5">
          {ADMIN_PERMISSIONS.map((p) => (
            <label
              key={p.key}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-xl border border-exchange-border px-3 py-2.5 transition-colors',
                checked.includes(p.key) && 'border-exchange-yellow/50 bg-exchange-yellow/5',
                (isSuper || isSelf) && 'opacity-50',
              )}
            >
              <input
                type="checkbox"
                checked={isSuper || checked.includes(p.key)}
                onChange={() => toggle(p.key)}
                disabled={isSuper || isSelf}
                className="h-4 w-4 accent-yellow-400"
              />
              <span className="text-sm font-semibold text-exchange-text">{p.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {isSelf && (
        <p className="mt-2 text-xs font-semibold text-exchange-sell">
          Kendi yetkilerini değiştiremezsin.
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button size="sm" onClick={() => picked && onSave(picked.id, isSuper, checked)} disabled={!canSave}>
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </Button>
      </div>
    </ModalShell>
  )
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-3 pb-safe backdrop-blur-[2px] sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-exchange-border bg-exchange-card p-4 shadow-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-base font-bold text-exchange-text">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-exchange-muted transition-colors hover:bg-exchange-border/40 hover:text-exchange-text"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function UsersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16V7" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  )
}

function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 13l3 3 7-7" />
    </svg>
  )
}
