import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAllTickers, type MarketStatus } from '@/hooks/useAllTickers'
import { matchPairQuery } from '@/lib/coinSearch'
import { cn, formatCompact, formatNumber, formatPrice, formatSignedPercent } from '@/lib/utils'
import type { Ticker } from '@/types'

export function MarketsPage() {
  const { tickers, status } = useAllTickers()
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const rows = useMemo(() => {
    let entries = Object.values(tickers).filter((t) => t.symbol.endsWith('USDT') && t.price > 0)
    if (query.trim()) {
      entries = entries.filter((t) => matchPairQuery(t.symbol, query))
    }
    return entries
      .map((t) => ({ ...t, quoteVolume: t.price * t.volume24h }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
  }, [tickers, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-exchange-border px-4 py-3">
        <div>
          <h1 className="text-lg font-bold text-exchange-text">Piyasalar</h1>
          <p className="text-xs text-exchange-muted">
            Tüm USDT işlem çiftleri · canlı fiyatlar
          </p>
        </div>
        <LiveChip status={status} />
        <div className="relative ml-auto w-full max-w-xs">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-exchange-muted">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20 L16.5 16.5" strokeLinecap="round" />
            </svg>
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Coin ara… (örn. SOL, ether, bitcoin)"
            className="h-9 w-full rounded-lg border border-exchange-border bg-exchange-bg pl-9 pr-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/70"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-exchange-surface">
            <tr className="border-b border-exchange-border text-xs uppercase text-exchange-muted">
              <th className="px-4 py-2.5 text-left font-semibold">Coin</th>
              <th className="px-4 py-2.5 text-right font-semibold">Son Fiyat</th>
              <th className="px-4 py-2.5 text-right font-semibold">24s Değişim %</th>
              <th className="px-4 py-2.5 text-right font-semibold">24s Hacim</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className="px-4 py-16 text-center text-sm text-exchange-muted">
                    {query ? `"${query}" için sonuç bulunamadı.` : 'Piyasa verisi yükleniyor…'}
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((t) => <MarketRow key={t.symbol} ticker={t} onSelect={navigate} />)
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-exchange-border px-4 py-2 text-xs text-exchange-muted">
        <span>{formatNumber(rows.length, 0)} USDT çifti</span>
        <span>Satıra tıklayın → işlem ekranı</span>
      </div>
    </div>
  )
}

function LiveChip({ status }: { status: MarketStatus }) {
  const live = status === 'live'
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
        live
          ? 'border-exchange-buy/40 text-exchange-buy'
          : 'border-exchange-muted/40 text-exchange-muted',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-exchange-buy' : 'animate-pulse bg-exchange-yellow')} />
      {live ? 'CANLI' : status === 'loading' ? 'YÜKLENİYOR' : 'BAĞLANTI YENİDEN KURULUYOR'}
    </span>
  )
}

function MarketRow({
  ticker,
  onSelect,
}: {
  ticker: Ticker & { quoteVolume: number }
  onSelect: (to: string) => void
}) {
  const up = ticker.changePercent24h >= 0
  return (
    <tr
      onClick={() => onSelect(`/spot?symbol=${ticker.symbol}`)}
      className="cursor-pointer border-b border-exchange-border/50 transition-colors last:border-0 hover:bg-exchange-surface"
    >
      <td className="px-4 py-2.5">
        <span className="flex items-baseline gap-1.5">
          <span className="font-semibold text-exchange-text">{ticker.symbol.replace('USDT', '')}</span>
          <span className="text-xs text-exchange-muted">USDT</span>
        </span>
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-exchange-text">
        {formatPrice(ticker.price)}
      </td>
      <td
        className={cn(
          'px-4 py-2.5 text-right font-mono font-semibold',
          up ? 'text-exchange-buy' : 'text-exchange-sell',
        )}
      >
        {formatSignedPercent(ticker.changePercent24h)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-exchange-muted">
        {formatCompact(ticker.quoteVolume)}
      </td>
    </tr>
  )
}