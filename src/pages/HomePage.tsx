import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAllTickers } from '@/hooks/useAllTickers'
import { useTradeStore } from '@/store/tradeStore'
import { useUiStore } from '@/store/uiStore'
import { useAuthUser } from '@/store/authStore'
import { cn, formatCompact, formatNumber, formatPrice, formatSignedPercent } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { AnnouncementBanner } from '@/components/AnnouncementBanner'
import type { Ticker } from '@/types'

const FEATURED = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP'] as const

export function HomePage() {
  const user = useAuthUser()
  const balance = useTradeStore((s) => s.balance)
  const positions = useTradeStore((s) => s.positions)
  const openDeposit = useUiStore((s) => s.openDeposit)
  const openWithdraw = useUiStore((s) => s.openWithdraw)
  const navigate = useNavigate()
  const { tickers } = useAllTickers()

  const featured = useMemo(
    () =>
      FEATURED.map((b) => tickers[`${b}USDT`])
        .filter((t): t is Ticker => Boolean(t))
        .sort((a, b) => b.price * b.volume24h - a.price * a.volume24h),
    [tickers],
  )

  const movers = useMemo(() => {
    const list = Object.values(tickers).filter(
      (t) => t.symbol.endsWith('USDT') && t.price > 0,
    )
    const sorted = [...list].sort((a, b) => b.changePercent24h - a.changePercent24h)
    return { gainers: sorted.slice(0, 5), losers: sorted.slice(-5).reverse() }
  }, [tickers])

  const goMarket = (symbol: string) => navigate(`/spot?symbol=${symbol}`)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <AnnouncementBanner />
      {/* Hero band */}
      <section className="border-b border-exchange-border bg-exchange-surface/60 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm text-exchange-muted">
              Hoş geldin, <span className="font-semibold text-exchange-text">{user?.username}</span> 👋
            </p>
            <h1 className="mt-1 text-xl font-bold text-exchange-text sm:text-2xl">Varlıklarınız</h1>
            <div className="mt-2 font-mono text-2xl font-bold text-exchange-text sm:text-3xl">
              {formatNumber(balance, 2)}{' '}
              <span className="text-base text-exchange-yellow">USDT</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button variant="outline" onClick={() => navigate('/markets')} className="whitespace-nowrap">
              Piyasaları Gör
            </Button>
            <Button onClick={() => navigate(positions.length > 0 ? '/futures' : '/spot')} className="whitespace-nowrap">
              İşlem Yap
            </Button>
            <Button
              variant="buy"
              onClick={openDeposit}
              className="whitespace-nowrap border border-exchange-buy/50"
            >
              + Para Yatır
            </Button>
            <Button variant="outline" onClick={openWithdraw} className="whitespace-nowrap">
              - Para Çek
            </Button>
          </div>
        </div>
      </section>

      {/* Featured coins */}
      <section className="border-b border-exchange-border px-4 py-4 sm:px-6 sm:py-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Öne Çıkan Piyasalar
          </h2>
          <button
            onClick={() => navigate('/markets')}
            className="text-xs font-semibold text-exchange-yellow hover:underline"
          >
            Tümünü gör →
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {featured.map((t) => (
            <CoinCard key={t.symbol} ticker={t} onClick={() => goMarket(t.symbol)} />
          ))}
        </div>
      </section>

      {/* Movers */}
      <section className="grid flex-1 grid-cols-1 gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-5 lg:grid-cols-2">
        <MoverList title="En Çok Yükselenler" list={movers.gainers} onSelect={goMarket} positive />
        <MoverList title="En Çok Düşenler" list={movers.losers} onSelect={goMarket} positive={false} />
      </section>
    </div>
  )
}

function CoinCard({ ticker, onClick }: { ticker: Ticker; onClick: () => void }) {
  const up = ticker.changePercent24h >= 0
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-exchange-border bg-exchange-card p-3 text-left transition-colors hover:border-exchange-yellow/50"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-exchange-text">
          {ticker.symbol.replace('USDT', '')}
        </span>
        <span
          className={cn(
            'font-mono text-xs font-semibold',
            up ? 'text-exchange-buy' : 'text-exchange-sell',
          )}
        >
          {formatSignedPercent(ticker.changePercent24h)}
        </span>
      </div>
      <div className="mt-1.5 font-mono text-base font-bold text-exchange-text">
        {formatPrice(ticker.price)}
      </div>
      <div className="mt-0.5 text-[11px] text-exchange-muted">
        Hacim {formatCompact(ticker.price * ticker.volume24h)}
      </div>
    </button>
  )
}

function MoverList({
  title,
  list,
  onSelect,
  positive,
}: {
  title: string
  list: Ticker[]
  onSelect: (symbol: string) => void
  positive: boolean
}) {
  return (
    <div className="rounded-xl border border-exchange-border bg-exchange-card">
      <h2
        className={cn(
          'border-b border-exchange-border px-4 py-3 text-sm font-bold uppercase tracking-wide',
          positive ? 'text-exchange-buy' : 'text-exchange-sell',
        )}
      >
        {title}
      </h2>
      {list.map((t) => {
        const up = t.changePercent24h >= 0
        return (
          <button
            key={t.symbol}
            onClick={() => onSelect(t.symbol)}
            className="flex w-full items-center justify-between border-b border-exchange-border/40 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-exchange-surface"
          >
            <span className="text-sm font-semibold text-exchange-text">
              {t.symbol.replace('USDT', '')}
              <span className="ml-1.5 text-xs text-exchange-muted">USDT</span>
            </span>
            <span className="font-mono text-sm font-medium text-exchange-text">
              {formatPrice(t.price)}
            </span>
            <span
              className={cn(
                'w-16 text-right font-mono text-xs font-semibold',
                up ? 'text-exchange-buy' : 'text-exchange-sell',
              )}
            >
              {formatSignedPercent(t.changePercent24h)}
            </span>
          </button>
        )
      })}
    </div>
  )
}