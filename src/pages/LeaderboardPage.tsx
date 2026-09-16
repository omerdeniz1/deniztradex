import { useCallback, useEffect, useState } from 'react'
import { useToastStore } from '@/store/toastStore'
import { getSessionUser } from '@/services/authService'
import { getLeaderboard, type TraderEntry } from '@/services/leaderboardService'
import { cn, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { VerifiedBadge } from '@/components/forum/VerifiedBadge'

export function LeaderboardPage() {
  const pushToast = useToastStore((s) => s.push)
  const [entries, setEntries] = useState<TraderEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const myUsername = getSessionUser()?.username.trim().toLowerCase() ?? null

  const load = useCallback(
    async (silent?: boolean) => {
      if (!silent) setLoading(true)
      setError(null)
      try {
        // RPC en fazla 100 kayıt döner — tüm kullanıcılar erişilebilir olsun.
        setEntries(await getLeaderboard(100))
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Sıralama yüklenemedi. Lütfen tekrar dene.'
        setError(msg)
        if (!silent) pushToast({ message: msg, tone: 'error' })
      } finally {
        setLoading(false)
      }
    },
    [pushToast],
  )

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-3 py-4 pb-28 sm:px-4 sm:py-6 md:pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-exchange-text sm:text-xl">Sıralama</h1>
            <p className="mt-0.5 text-xs text-exchange-muted">
              Trader Skoru = Portföy %40 · Hacim %30 · Performans %30
            </p>
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

        <div className="mt-4 overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
          {loading && entries.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">
              Sıralama yükleniyor…
            </div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-exchange-muted">
              {error ? 'Sıralama gösterilemiyor.' : 'Henüz sıralanacak kullanıcı yok.'}
            </div>
          ) : (
            // Tablo kendi kutusunda kayar (başlık sabit kalır): mobilde de
            // masaüstünde de sayfa düzeni bozulmadan tüm satırlara inilir.
            // Masaüstünde kutu sınırsızdır, kaydırma sayfanındır.
            <div className="max-h-[62dvh] overflow-y-auto overscroll-contain md:max-h-none md:overflow-visible">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-exchange-border bg-exchange-card text-[11px] uppercase tracking-wide text-exchange-muted">
                    <th scope="col" className="w-10 bg-exchange-card px-2.5 py-2.5 text-center font-semibold sm:w-12 sm:px-3">#</th>
                    <th scope="col" className="bg-exchange-card px-2.5 py-2.5 font-semibold sm:px-3">Kullanıcı</th>
                    <th scope="col" className="bg-exchange-card px-2.5 py-2.5 text-right font-semibold sm:px-3">Portföy</th>
                    <th scope="col" className="hidden bg-exchange-card px-3 py-2.5 text-right font-semibold sm:table-cell sm:px-4">Hacim</th>
                    <th scope="col" className="bg-exchange-card px-2.5 py-2.5 text-right font-semibold sm:px-3">Skor</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const isMe = myUsername !== null && e.username.trim().toLowerCase() === myUsername
                    return (
                      <tr
                        key={`${e.rank}-${e.username}`}
                        className={cn(
                          'border-b border-exchange-border/50 last:border-0',
                          isMe && 'bg-exchange-yellow/5',
                        )}
                      >
                        <td className="px-2 py-2.5 text-center sm:px-3">
                          <RankMedal rank={e.rank} />
                        </td>
                        <td className="px-2.5 py-3 sm:px-3 sm:py-2.5">
                          <div className="flex min-w-0 items-center gap-2">
                            {e.avatarUrl ? (
                              <img
                                src={e.avatarUrl}
                                alt=""
                                className="h-9 w-9 shrink-0 rounded-full object-cover"
                              />
                            ) : (
                              <span
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-sm font-extrabold text-exchange-yellow"
                                aria-hidden
                              >
                                {(e.username.charAt(0) || '?').toUpperCase()}
                              </span>
                            )}
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-1">
                                <span className="truncate text-sm font-bold text-exchange-text">
                                  {e.username}
                                </span>
                                {e.isAdmin ? (
                                  <VerifiedBadge small tone="gold" />
                                ) : e.isSubAdmin ? (
                                  <VerifiedBadge small tone="blue" />
                                ) : null}
                              </div>
                              {isMe && (
                                <div className="text-[10px] font-bold uppercase tracking-wide text-exchange-yellow">
                                  Sen
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-3 text-right font-mono text-sm font-bold text-exchange-text sm:px-3 sm:py-2.5">
                          {formatNumber(e.balance, 2)}
                        </td>
                        <td className="hidden whitespace-nowrap px-3 py-2.5 text-right font-mono text-exchange-muted sm:table-cell sm:px-4">
                          {formatNumber(e.volume, 2)}
                        </td>
                        <td className="px-2.5 py-3 sm:px-3 sm:py-2.5">
                          <div className="flex items-center justify-end gap-2">
                            <span className="h-2 w-10 shrink-0 overflow-hidden rounded-full bg-exchange-border/50 sm:w-20">
                              <span
                                className="block h-full rounded-full bg-exchange-yellow"
                                style={{ width: `${Math.min(100, Math.max(0, e.score))}%` }}
                              />
                            </span>
                            <span className="w-9 shrink-0 text-right font-mono text-xs font-extrabold text-exchange-text sm:w-10">
                              {formatNumber(e.score, 1)}
                            </span>
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

        <p className="mt-3 px-1 text-[11px] leading-relaxed text-exchange-muted">
          Skor 0-100 aralığındadır ve tüm kullanıcılara göre normalize edilir. Portföy hesap
          varlığını, hacim toplam işlem tutarını, performans alış-satış dengesini yansıtır.
          Yasaklı hesaplar sıralamaya alınmaz.
        </p>
      </div>
    </div>
  )
}

function RankMedal({ rank }: { rank: number }) {
  if (rank > 3) {
    return <span className="font-mono text-sm font-bold text-exchange-muted">{rank}</span>
  }
  const styles =
    rank === 1
      ? 'bg-[#ffc107]/15 text-[#ffc107]'
      : rank === 2
        ? 'bg-slate-300/15 text-slate-300'
        : 'bg-amber-600/15 text-amber-500'
  return (
    <span
      className={cn(
        'mx-auto flex h-8 w-8 items-center justify-center rounded-full font-mono text-sm font-extrabold',
        styles,
      )}
      aria-label={`${rank}. sıra`}
    >
      {rank}
    </span>
  )
}
