import { useCallback, useEffect, useState } from 'react'
import { useToastStore } from '@/store/toastStore'
import { listActiveEvents, type EventItem } from '@/services/eventService'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

function formatRange(e: EventItem): string | null {
  const fmt = (n: number) =>
    new Date(n).toLocaleString('tr-TR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  if (e.startsAt && e.endsAt) return `${fmt(e.startsAt)} → ${fmt(e.endsAt)}`
  if (e.startsAt) return `${fmt(e.startsAt)} itibarıyla`
  if (e.endsAt) return `${fmt(e.endsAt)} tarihine kadar`
  return null
}

export function EventsPage() {
  const pushToast = useToastStore((s) => s.push)
  const [events, setEvents] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setEvents(await listActiveEvents(20))
    } catch {
      pushToast({ message: 'Etkinlikler yüklenemedi.', tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-3 py-4 pb-28 sm:px-4 sm:py-6 md:pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-exchange-text sm:text-xl">Etkinlikler</h1>
            <p className="mt-0.5 text-xs text-exchange-muted">Yarışmalar, ödüller ve platform duyuruları</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? 'Yükleniyor…' : 'Yenile'}
          </Button>
        </div>

        <div className="mt-4">
          {loading && events.length === 0 ? (
            <div className="rounded-2xl border border-exchange-border bg-exchange-card px-4 py-12 text-center text-sm text-exchange-muted">
              Etkinlikler yükleniyor…
            </div>
          ) : events.length === 0 ? (
            <div className="rounded-2xl border border-exchange-border bg-exchange-card px-4 py-12 text-center">
              <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-exchange-yellow/10 text-exchange-yellow" aria-hidden>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
                </svg>
              </div>
              <p className="text-sm font-bold text-exchange-text">Şu an aktif bir etkinlik yok.</p>
              <p className="mt-1 text-xs leading-relaxed text-exchange-muted">
                Yeni etkinlikler burada yayınlanacak — yakında tekrar göz at.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {events.map((e) => {
                const range = formatRange(e)
                return (
                  <li
                    key={e.id}
                    className="overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card"
                  >
                    <div className="border-l-4 border-l-exchange-yellow px-3 py-3 sm:px-4">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-bold text-exchange-text">
                          {e.title}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide',
                            'bg-exchange-buy/15 text-exchange-buy',
                          )}
                        >
                          Aktif
                        </span>
                      </div>
                      {range && (
                        <div className="mt-1 font-mono text-[11px] text-exchange-yellow">{range}</div>
                      )}
                      <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-exchange-muted sm:text-sm sm:text-exchange-text">
                        {e.body}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
