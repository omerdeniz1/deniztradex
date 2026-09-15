import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import {
  ADMIN_PERMISSIONS,
  deleteForumPostsBulk,
  getMyAdminAccess,
  getPlatformStats,
  hasAdminPermission,
  listAdminUsers,
  listForumAdminPosts,
  sendPasswordReset,
  setAdminPrivileges,
  setMoneyRestrictions,
  setUserBanned,
  setUserFrozen,
  updateUserBalance,
  validateBalanceInput,
  type AdminAccess,
  type AdminForumPost,
  type AdminPermission,
  type AdminUser,
  type PlatformStats,
} from '@/services/adminService'
import { cn, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'

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
    | { mode: 'password'; user: AdminUser }
    | { mode: 'restrict'; user: AdminUser }
    | { mode: 'privs'; user: AdminUser | null }
    | { mode: 'revoke'; user: AdminUser }
    | null
  >(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const can = useCallback((perm: AdminPermission) => hasAdminPermission(access, perm), [access])

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

  const saveRestrictions = async (
    user: AdminUser,
    input: { depositBlocked: boolean; withdrawBlocked: boolean },
  ) => {
    setBusyId(user.id)
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

  const resetPassword = async (user: AdminUser) => {    setBusyId(user.id)
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
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-3 py-4 sm:px-4 sm:py-6">
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

        {/* Genel istatistik kartları */}
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

        {/* Kullanıcı yönetimi */}
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
            // Scroll düzeltmesi: kayıt çokken tablo kendi bölgesinde
            // dikey kayar (başlık sabit), sayfa akışı bozulmaz.
            <div className="max-h-[65dvh] overflow-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-exchange-border text-[11px] uppercase tracking-wide text-exchange-muted">
                    <th scope="col" className="sticky top-0 z-10 bg-exchange-card px-3 py-2.5 font-semibold sm:px-4">Kullanıcı</th>
                    <th scope="col" className="sticky top-0 z-10 bg-exchange-card px-3 py-2.5 font-semibold sm:px-4">E-posta</th>
                    <th scope="col" className="sticky top-0 z-10 bg-exchange-card px-3 py-2.5 text-right font-semibold sm:px-4">Bakiye (USDT)</th>
                    <th scope="col" className="sticky top-0 z-10 bg-exchange-card px-3 py-2.5 font-semibold sm:px-4">Durum</th>
                    <th scope="col" className="sticky top-0 z-10 bg-exchange-card px-3 py-2.5 text-right font-semibold sm:px-4">İşlemler</th>
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
                              <span
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-xs font-extrabold text-exchange-yellow"
                                aria-hidden
                              >
                                {(u.username.charAt(0) || '?').toUpperCase()}
                              </span>
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
                            {can('edit_balance') && (
                              <RowButton
                                label="Bakiye"
                                title={`${u.username} bakiyesini düzenle`}
                                disabled={busyId === u.id}
                                onClick={() => setModal({ mode: 'balance', user: u })}
                              />
                            )}
                            {can('ban_users') && (
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
                            {can('change_password') && u.email && (
                              <RowButton
                                label="Şifre"
                                title={`${u.username} için şifre sıfırlama e-postası gönder`}
                                disabled={busyId === u.id}
                                onClick={() => setModal({ mode: 'password', user: u })}
                              />
                            )}
                            {can('restrict_money') && (
                              <RowButton
                                label="Kısıtla"
                                title={`${u.username} için para yatırma/çekme kısıtları`}
                                disabled={busyId === u.id}
                                onClick={() => setModal({ mode: 'restrict', user: u })}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Forum denetimi: tekli + toplu silme (ban yetkisi gerekir) */}
        {can('ban_users') && <ForumModeration />}

        {/* Yönetici yetkileri (yalnızca admin ekleyebilenler) */}
        {can('manage_admins') && (          <div className="mt-5 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
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

function ForumModeration() {
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

  const toggleAll = () => {
    setSelected((prev) => (prev.size === posts.length ? new Set() : new Set(posts.map((p) => p.id))))
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
        <div className="max-h-[50dvh] overflow-auto">
          <ul>
            <li className="sticky top-0 z-10 flex items-center gap-2 border-b border-exchange-border bg-exchange-card px-3 py-2 sm:px-4">
              <input
                type="checkbox"
                checked={posts.length > 0 && selected.size === posts.length}
                onChange={toggleAll}
                aria-label="Tümünü seç"
                className="h-4 w-4 shrink-0 accent-yellow-400"
              />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-exchange-muted">
                Tümünü seç
              </span>
            </li>
            {posts.map((p) => (
              <li
                key={p.id}
                className="flex items-start gap-2 border-b border-exchange-border/50 px-3 py-2.5 last:border-0 sm:px-4"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  aria-label={`${p.username} gönderisini seç`}
                  className="mt-1 h-4 w-4 shrink-0 accent-yellow-400"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-xs font-bold text-exchange-text">
                      {p.username}
                    </span>
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
                  disabled={busy}
                  aria-label={`${p.username} gönderisini sil`}
                  className="shrink-0 whitespace-nowrap rounded-lg border border-exchange-sell/40 px-2.5 py-1.5 text-xs font-bold text-exchange-sell transition-colors hover:bg-exchange-sell/10 disabled:opacity-40"
                >
                  Sil
                </button>
              </li>
            ))}
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 backdrop-blur-[2px] sm:items-center"
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
