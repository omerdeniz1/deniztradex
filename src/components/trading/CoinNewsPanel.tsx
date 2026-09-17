import { useState } from 'react'
import { useCoinNews } from '@/hooks/useCoinMeta'
import { cn } from '@/lib/utils'

/**
 * İşlem ekranı coin haber bandı: adminin o sembol için girdiği
 * haberler (yükseltme/düşürme duyuruları dahil) burada görünür.
 * Haber yoksa hiç render edilmez.
 */
export function CoinNewsPanel({ symbol }: { symbol: string }) {
  const { news, loading } = useCoinNews(symbol, 3)
  const [open, setOpen] = useState(false)

  if (!loading && news.length === 0) return null

  const latest = news[0]
  return (
    <div className="border-b border-exchange-border bg-exchange-yellow/[0.05] px-3 py-2 sm:px-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="shrink-0 rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-exchange-yellow">
          Haber
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-exchange-text">
          {loading ? 'Haberler yükleniyor…' : latest?.title}
        </span>
        {news.length > 1 && (
          <span className="shrink-0 font-mono text-[10px] text-exchange-muted">
            +{news.length - 1}
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
          className={cn('shrink-0 text-exchange-muted transition-transform', open && 'rotate-180')}
        >
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && !loading && (
        <ul className="mt-2 space-y-1.5">
          {news.map((n) => (
            <li key={n.id} className="rounded-lg bg-exchange-bg/60 px-2.5 py-1.5">
              <div className="text-xs font-bold text-exchange-text">{n.title}</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-exchange-muted">
                {n.body}
              </p>
              <div className="mt-0.5 font-mono text-[10px] text-exchange-muted">
                {new Date(n.createdAt).toLocaleString('tr-TR')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
