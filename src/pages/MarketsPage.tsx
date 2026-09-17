import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUnifiedTickers } from '@/hooks/useUnifiedTickers'
import { useCoinOverrides } from '@/hooks/useCoinMeta'
import type { MarketStatus } from '@/hooks/useAllTickers'
import { matchPairQuery } from '@/lib/coinSearch'
import { cn, formatCompact, formatNumber, formatPrice, formatSignedPercent } from '@/lib/utils'
import type { Ticker } from '@/types'

export function MarketsPage() {
  // Birleşik piyasa: Binance gerçek coinleri + Sanal Piyasa tek tabloda.
  // Sanal satırlar rozetsiz/ayrımsız — BTC satırıyla birebir aynı görünür.
  const { tickers, virtualSymbols, status } = useUnifiedTickers()
  const overrides = useCoinOverrides()
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const rows = useMemo(() => {
    let entries = Object.values(tickers).filter(
      (t) =>
        (t.symbol.endsWith('USDT') || virtualSymbols.has(t.symbol.toUpperCase())) && t.price > 0,
    )
    if (query.trim()) {
      entries = entries.filter((t) => matchPairQuery(t.symbol, query))
    }
    // Admin sıralaması: yükseltilenler en üstte, düşürülenler en altta.
    const rank = (s: string) =>
      overrides[s.toUpperCase()] === 'promoted' ? 0 : overrides[s.toUpperCase()] === 'demoted' ? 2 : 1
    return entries
      .map((t) => ({ ...t, quoteVolume: t.price * t.volume24h }))
      .sort((a, b) => rank(a.symbol) - rank(b.symbol) || b.quoteVolume - a.quoteVolume)
  }, [tickers, virtualSymbols, query, overrides])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b border-exchange-border px-3 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-bold text-exchange-text">Piyasalar</h1>
            <p className="text-xs text-exchange-muted">
              Tüm USDT işlem çiftleri · canlı fiyatlar
            </p>
          </div>
          <LiveChip status={status} />
        </div>
        <div className="relative w-full sm:ml-auto sm:max-w-xs">
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
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-exchange-surface">
            <tr className="border-b border-exchange-border text-xs uppercase text-exchange-muted">
              <th className="px-3 py-2.5 text-left font-semibold sm:px-4">Coin</th>
              <th className="px-3 py-2.5 text-right font-semibold sm:px-4">Son Fiyat</th>
              <th className="px-3 py-2.5 text-right font-semibold sm:px-4">24s %</th>
              <th className="hidden px-4 py-2.5 text-right font-semibold sm:table-cell">24s Hacim</th>
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
              rows.map((t) => (
                <MarketRow
                  key={t.symbol}
                  ticker={t}
                  status={overrides[t.symbol.toUpperCase()] ?? 'normal'}
                  onSelect={navigate}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-exchange-border px-3 py-2 text-xs text-exchange-muted sm:px-4">
        <span>{formatNumber(rows.length, 0)} işlem çifti</span>
        <span className="hidden sm:inline">Satıra tıklayın → işlem ekranı</span>
        <span className="sm:hidden">Dokun → işlem ekranı</span>
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
  status,
  onSelect,
}: {
  ticker: Ticker & { quoteVolume: number }
  status: 'normal' | 'promoted' | 'demoted'
  onSelect: (to: string) => void
}) {
  const up = ticker.changePercent24h >= 0
  return (
    <tr
      onClick={() => onSelect(`/spot?symbol=${ticker.symbol}`)}
      className={cn(
        'cursor-pointer border-b border-exchange-border/50 transition-colors last:border-0 hover:bg-exchange-surface',
        status === 'demoted' && 'opacity-50',
        status === 'promoted' && 'bg-exchange-yellow/[0.04]',
      )}
    >
      <td className="px-3 py-2.5 sm:px-4">
        <span className="flex items-center gap-1.5">
          <span className="font-semibold text-exchange-text">{ticker.symbol.replace('USDT', '')}</span>
          <span className="text-xs text-exchange-muted">USDT</span>
          {status === 'promoted' && (
            <span className="rounded-full bg-exchange-buy/15 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-exchange-buy">
              Öne Çıkan
            </span>
          )}
          {status === 'demoted' && (
            <span className="rounded-full bg-exchange-border/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-exchange-muted">
              Düşük
            </span>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-exchange-text sm:px-4">
        {formatPrice(ticker.price)}
      </td>
      <td
        className={cn(
          'whitespace-nowrap px-3 py-2.5 text-right font-mono font-semibold sm:px-4',
          up ? 'text-exchange-buy' : 'text-exchange-sell',
        )}
      >
        {formatSignedPercent(ticker.changePercent24h)}
      </td>
      <td className="hidden whitespace-nowrap px-4 py-2.5 text-right font-mono text-exchange-muted sm:table-cell">
        {formatCompact(ticker.quoteVolume)}
      </td>
    </tr>
  )
}