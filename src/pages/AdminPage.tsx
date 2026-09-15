import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useToastStore } from '@/store/toastStore'
import {
  checkIsAdmin,
  getPlatformStats,
  listAdminUsers,
  setUserFrozen,
  updateUserBalance,
  validateBalanceInput,
  type AdminUser,
  type PlatformStats,
} from '@/services/adminService'
import { cn, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

type Access = 'checking' | 'allowed' | 'denied'

export function AdminPage() {
  const [access, setAccess] = useState<Access>('checking')

  // Admin Guard: yetki DB'den okunur. Oturumsuz / normal kullanıcı
  // ana sayfaya yönlendirilir — istemcideki hiçbir bayrak yetki sayılmaz.
  useEffect(() => {
    let live = true
    void checkIsAdmin().then((ok) => {
      if (live) setAccess(ok ? 'allowed' : 'denied')
    })
    return () => {
      live = false
    }
  }, [])

  if (access === 'denied') return <Navigate to="/" replace />
  if (access === 'checking') {
    return (
      <div className="flex h-full items-center justify-center px-4 py-16 text-sm text-exchange-muted">
        Yetki denetleniyor…
      </div>
    )
  }
  return <AdminDashboard />
}

function AdminDashboard() {
  const pushToast = useToastStore((s) => s.push)
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<
    | { mode: 'balance'; user: AdminUser }
    | { mode: 'freeze'; user: AdminUser }
    | null
  >(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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

  const frozenCount = users.filter((u) => u.isFrozen).length

  const saveBalance = async (user: AdminUser, raw: string) => {
    let value: number
    try {
      value = validateBalanceInput(raw)
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Geçersiz bakiye.', tone: 'error' })
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
      pushToast({ message: err instanceof Error ? err.message : 'Bakiye güncellenemedi.', tone: 'error' })
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
      pushToast({ message: err instanceof Error ? err.message : 'İşlem yapılamadı.', tone: 'error' })
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
                Yönetici
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-exchange-border text-[11px] uppercase tracking-wide text-exchange-muted">
                    <th scope="col" className="px-3 py-2.5 font-semibold sm:px-4">Kullanıcı</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold sm:px-4">E-posta</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-semibold sm:px-4">Bakiye (USDT)</th>
                    <th scope="col" className="px-3 py-2.5 font-semibold sm:px-4">Durum</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-semibold sm:px-4">İşlemler</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => (
                    <tr key={u.id} className="border-b border-exchange-border/50 last:border-0">
                      <td className="px-3 py-2.5 sm:px-4">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-xs font-extrabold text-exchange-yellow"
                            aria-hidden
                          >
                            {(u.username.charAt(0) || '?').toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-bold text-exchange-text">{u.username}</div>
                            {u.isAdmin && (
                              <div className="text-[10px] font-bold uppercase tracking-wide text-exchange-yellow">
                                Admin
                              </div>
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
                        <span
                          className={cn(
                            'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold',
                            u.isFrozen
                              ? 'bg-exchange-sell/10 text-exchange-sell'
                              : 'bg-exchange-buy/10 text-exchange-buy',
                          )}
                        >
                          {u.isFrozen ? 'Dondurulmuş' : 'Aktif'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 sm:px-4">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setModal({ mode: 'balance', user: u })}
                            disabled={busyId === u.id}
                            aria-label={`${u.username} bakiyesini düzenle`}
                            className="whitespace-nowrap rounded-lg border border-exchange-border px-2.5 py-1.5 text-xs font-bold text-exchange-text transition-colors hover:border-exchange-yellow hover:text-exchange-yellow disabled:opacity-40"
                          >
                            Bakiye
                          </button>
                          <button
                            type="button"
                            onClick={() => setModal({ mode: 'freeze', user: u })}
                            disabled={busyId === u.id}
                            aria-label={u.isFrozen ? `${u.username} hesabını çöz` : `${u.username} hesabını dondur`}
                            className={cn(
                              'whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-40',
                              u.isFrozen
                                ? 'border-exchange-buy/40 text-exchange-buy hover:bg-exchange-buy/10'
                                : 'border-exchange-sell/40 text-exchange-sell hover:bg-exchange-sell/10',
                            )}
                          >
                            {busyId === u.id ? '…' : u.isFrozen ? 'Çöz' : 'Dondur'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="mt-3 px-1 text-[11px] leading-relaxed text-exchange-muted">
          Bakiye değişiklikleri anında profile yansır. Dondurulan hesaplar bir sonraki girişte
          engellenir. Emirler cihazda tutulur; panel sunucu verilerini gösterir.
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
        <FreezeModal
          user={modal.user}
          busy={busyId === modal.user.id}
          onClose={() => setModal(null)}
          onConfirm={() => void toggleFreeze(modal.user)}
        />
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

function FreezeModal({
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
  const freezing = !user.isFrozen
  return (
    <ModalShell title={freezing ? 'Hesabı dondur' : 'Hesabı çöz'} onClose={onClose}>
      <p className="text-sm leading-relaxed text-exchange-text">
        <span className="font-bold">{user.username}</span> ({user.email || 'e-posta yok'}) hesabı{' '}
        {freezing ? (
          <>
            <span className="font-bold text-exchange-sell">dondurulacak</span>. Bu kullanıcı bir
            sonraki girişte engellenir.
          </>
        ) : (
          <>
            <span className="font-bold text-exchange-buy">çözülecek</span> ve tekrar giriş
            yapabilecek.
          </>
        )}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Vazgeç
        </Button>
        <Button size="sm" variant={freezing ? 'sell' : 'buy'} onClick={onConfirm} disabled={busy}>
          {busy ? 'İşleniyor…' : freezing ? 'Dondur' : 'Çöz'}
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
        className="w-full max-w-md rounded-2xl border border-exchange-border bg-exchange-card p-4 shadow-2xl sm:p-5"
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
