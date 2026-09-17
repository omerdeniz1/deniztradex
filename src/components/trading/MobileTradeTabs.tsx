import { useMemo, useState } from 'react'
import { useTradeStore } from '@/store/tradeStore'
import { useOrderStore } from '@/store/orderStore'
import { useToastStore } from '@/store/toastStore'
import { cn, formatNumber, formatPrice } from '@/lib/utils'
import type { OrderType, TradingMode } from '@/types'
import { PositionList } from '@/components/trading/PositionList'
import { FuturesHistory, SpotHistory } from '@/components/trading/TradeHistory'

interface Props {
  mode: TradingMode
  livePrices: Record<string, number>
}

type MobileTab = 'open' | 'history'

const ORDER_TYPE_SHORT: Record<OrderType, string> = {
  market: 'Piyasa',
  limit: 'Limit',
  'stop-market': 'Stop',
  'stop-limit': 'Stop-Limit',
  trailing: 'İzleyen',
  oco: 'OCO',
}

function sideLabel(side: string): { text: string; buy: boolean } {
  if (side === 'buy') return { text: 'Al', buy: true }
  if (side === 'sell') return { text: 'Sat', buy: false }
  if (side === 'long') return { text: 'Long', buy: true }
  return { text: 'Short', buy: false }
}

/**
 * Mobil alt sekmeler (Al-Sat / Vadeli): butonların altındaki tüm yazılar
 * ve tablolar kalkar; yerine sekmeli tek alan gelir. Masaüstü dokunulmaz
 * (bu bileşen yalnızca `md:hidden` ile gösterilir).
 */
export function MobileTradeTabs({ mode, livePrices }: Props) {
  const [tab, setTab] = useState<MobileTab>('open')

  const historyLabel = mode === 'spot' ? 'Alım-Satım Geçmişi' : 'İşlem Geçmişi'

  return (
    <div className="border-t border-exchange-border md:hidden">
      <div className="flex border-b border-exchange-border" role="tablist" aria-label="İşlem sekmeleri">
        {(
          [
            { id: 'open', label: 'Açık Emirler' },
            { id: 'history', label: historyLabel },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px flex-1 whitespace-nowrap border-b-2 px-2 py-2.5 text-sm font-bold transition-colors',
              tab === t.id
                ? 'border-exchange-yellow text-exchange-yellow'
                : 'border-transparent text-exchange-muted',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* İki yönlü kaydırma: yatay (geniş tablolar) korunur, dikey de
          kutu içinde akar — 4+ pozisyonda alttaki işlem görünür kalır.
          Alt boşluk sabit alt menünün altına kaymayı önler. */}
      <div className="max-h-[42dvh] min-h-[10rem] overflow-auto overscroll-contain pb-6">
        {tab === 'open' ? (
          mode === 'futures' ? (
            <FuturesOpen livePrices={livePrices} />
          ) : (
            <SpotOpen livePrices={livePrices} />
          )
        ) : mode === 'futures' ? (
          <FuturesHistoryWrap />
        ) : (
          <SpotHistoryWrap />
        )}
      </div>
    </div>
  )
}

function FuturesHistoryWrap() {
  const trades = useTradeStore((s) => s.trades)
  return <FuturesHistory trades={trades} />
}

function SpotHistoryWrap() {
  const spotTrades = useTradeStore((s) => s.spotTrades)
  return <SpotHistory trades={spotTrades} bare />
}

function FuturesOpen({ livePrices }: { livePrices: Record<string, number> }) {
  const pendingOrders = useOrderStore((s) => s.pendingOrders)
  const cancelPendingOrder = useOrderStore((s) => s.cancelPendingOrder)
  const pushToast = useToastStore((s) => s.push)

  const pending = useMemo(
    () => pendingOrders.filter((o) => o.mode === 'futures' && !o.filled),
    [pendingOrders],
  )

  return (
    <div>
      <PositionList livePrices={livePrices} />
      {pending.length > 0 && (
        <div className="border-t border-exchange-border">
          {pending.map((o) => {
            const s = sideLabel(o.side)
            return (
              <div key={o.id} className="flex items-center gap-2 border-b border-exchange-border/40 px-4 py-2 text-xs last:border-0">
                <span className="shrink-0 font-mono font-semibold text-exchange-text">{o.symbol}</span>
                <span className={cn('shrink-0 font-bold uppercase', s.buy ? 'text-exchange-buy' : 'text-exchange-sell')}>
                  {s.text}
                </span>
                <span className="min-w-0 flex-1 truncate text-exchange-muted">
                  {ORDER_TYPE_SHORT[o.orderType]}
                </span>
                <span className="shrink-0 font-mono text-exchange-text">
                  {formatPrice(o.entryPrice || o.stopPrice || 0)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    cancelPendingOrder(o.id)
                    pushToast({ message: `${o.symbol} — Emir iptal edildi`, tone: 'info' })
                  }}
                  className="shrink-0 text-xs font-semibold text-exchange-yellow hover:underline"
                >
                  İptal
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SpotOpen({ livePrices }: { livePrices: Record<string, number> }) {
  const spotBalances = useTradeStore((s) => s.spotBalances)
  const spotPositions = useTradeStore((s) => s.spotPositions)
  const closeSpotPosition = useTradeStore((s) => s.closeSpotPosition)

  const holdings = useMemo(
    () =>
      Object.entries(spotBalances)
        .filter(([, qty]) => qty > 0)
        .map(([coin, qty]) => {
          const price = livePrices[`${coin}USDT`] ?? 0
          return { coin, qty, price, value: qty * price }
        })
        .sort((a, b) => b.value - a.value),
    [spotBalances, livePrices],
  )

  if (spotPositions.length === 0 && holdings.length === 0) {
    return <div className="px-4 py-10 text-center text-xs text-exchange-muted">Açık emir yok.</div>
  }

  return (
    <div>
      {spotPositions.length > 0 && (
        <div className="border-b border-exchange-border/40">
          {spotPositions.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-exchange-border/40 px-4 py-2 text-xs last:border-0">
              <span className="shrink-0 font-mono font-semibold text-exchange-text">{p.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-exchange-muted">
                {formatNumber(p.quantity, 6)} adet
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono">
                <span className="text-exchange-buy">{p.tpPrice ? formatPrice(p.tpPrice) : '—'}</span>
                <span className="text-exchange-muted"> / </span>
                <span className="text-exchange-sell">{p.slPrice ? formatPrice(p.slPrice) : '—'}</span>
              </span>
              <button
                type="button"
                onClick={() => closeSpotPosition(p.id, livePrices[p.symbol] ?? p.entryPrice)}
                className="shrink-0 text-xs font-semibold text-exchange-yellow hover:underline"
              >
                İptal
              </button>
            </div>
          ))}
        </div>
      )}
      {holdings.map((h) => (
        <div key={h.coin} className="flex items-center gap-2.5 border-b border-exchange-border/40 px-4 py-2.5 last:border-0">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-exchange-buy/10 text-[11px] font-bold text-exchange-buy">
            {h.coin.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-exchange-text">{h.coin}</span>
          <span className="shrink-0 font-mono text-xs text-exchange-muted">
            {formatNumber(h.qty, 6)}
          </span>
          <span className="w-20 shrink-0 text-right font-mono text-xs font-semibold text-exchange-text">
            {formatNumber(h.value, 2)}
          </span>
        </div>
      ))}
    </div>
  )
}
