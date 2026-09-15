import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTradeStore } from '@/store/tradeStore'
import { cn, formatNumber, formatPnl, formatPrice, formatTime } from '@/lib/utils'
import type { TradingMode } from '@/types'

export function TradeHistory({ mode }: { mode: TradingMode }) {
  const trades = useTradeStore((s) => s.trades)
  const spotTrades = useTradeStore((s) => s.spotTrades)
  const [open, setOpen] = useState(true)

  return (
    <div className="border-b border-exchange-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-xs font-semibold uppercase tracking-wide text-exchange-muted hover:text-exchange-text"
        type="button"
      >
        <span>Trade History</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            {mode === 'spot'
              ? <SpotHistory trades={spotTrades} />
              : <FuturesHistory trades={trades} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function FuturesHistory({ trades }: { trades: ReturnType<typeof useTradeStore.getState>['trades'] }) {
  if (trades.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-exchange-muted">
        No trades yet — your closed positions will appear here.
      </div>
    )
  }

  return (
    <div className="max-h-44 overflow-auto">
      <table className="w-full min-w-[34rem] text-xs">
        <thead className="sticky top-0 bg-exchange-bg">
          <tr className="border-b border-exchange-border text-exchange-muted">
            <th className="px-4 py-1.5 text-left font-medium">Symbol</th>
            <th className="px-4 py-1.5 text-left font-medium">Side</th>
            <th className="px-4 py-1.5 text-right font-medium">Entry</th>
            <th className="px-4 py-1.5 text-right font-medium">Exit</th>
            <th className="px-4 py-1.5 text-right font-medium">Lev</th>
            <th className="px-4 py-1.5 text-right font-medium">PnL</th>
            <th className="px-4 py-1.5 text-left font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-exchange-border/40">
              <td className="px-4 py-1.5 font-medium">{t.symbol}</td>
              <td className="px-4 py-1.5">
                <span
                  className={cn(
                    'font-bold uppercase',
                    t.side === 'long' ? 'text-exchange-buy' : 'text-exchange-sell',
                  )}
                >
                  {t.side}
                </span>
              </td>
              <td className="px-4 py-1.5 text-right font-mono">
                {formatPrice(t.entryPrice)}
              </td>
              <td className="px-4 py-1.5 text-right font-mono">
                {formatPrice(t.exitPrice)}
              </td>
              <td className="px-4 py-1.5 text-right font-mono">
                {t.leverage}x
              </td>
              <td
                className={cn(
                  'px-4 py-1.5 text-right font-mono font-semibold',
                  t.pnl >= 0 ? 'text-exchange-buy' : 'text-exchange-sell',
                )}
              >
                {t.pnl >= 0 ? '+' : ''}
                {formatPnl(t.pnl)}
              </td>
              <td className="px-4 py-1.5">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] uppercase',
                    t.reason === 'liquidation'
                      ? 'bg-exchange-sell/10 text-exchange-sell'
                      : t.reason === 'tp_sl'
                        ? 'bg-exchange-yellow/10 text-exchange-yellow'
                        : 'bg-exchange-surface text-exchange-muted',
                  )}
                >
                  {t.reason === 'liquidation'
                    ? 'Likidasyon'
                    : t.reason === 'tp_sl'
                      ? 'TP / SL'
                      : t.reason === 'reduce'
                        ? 'Azaltma'
                        : 'Manuel'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SpotHistory({ trades, bare }: { trades: ReturnType<typeof useTradeStore.getState>['spotTrades']; bare?: boolean }) {
  return (
    <div>
      {!bare && (
        <div className="px-4 py-3">
          <p className="text-xs font-semibold text-exchange-text">Açık Emirler (Open Orders)</p>
          <p className="mt-1 text-[11px] text-exchange-muted">
            Spot işlemler anında gerçekleşir, bekleyen emir bulunmaz.
          </p>
        </div>
      )}

      <div className="text-xs">
        {!bare && (
          <p className="px-4 text-xs font-semibold text-exchange-text">
            Alım-Satım Geçmişi (Trade History)
          </p>
        )}
        {trades.length === 0 ? (
          <div className="px-4 py-6 text-center text-exchange-muted">
            Henüz işlem yapılmadı.
          </div>
        ) : (
          <div className="max-h-44 overflow-auto">
            <table className="w-full min-w-[34rem] text-xs">
              <thead className="sticky top-0 bg-exchange-bg">
                <tr className="border-b border-exchange-border text-exchange-muted">
                  <th className="px-4 py-1.5 text-left font-medium">Çift</th>
                  <th className="px-4 py-1.5 text-left font-medium">Yön</th>
                  <th className="px-4 py-1.5 text-right font-medium">Fiyat</th>
                  <th className="px-4 py-1.5 text-right font-medium">Miktar</th>
                  <th className="px-4 py-1.5 text-right font-medium">Toplam</th>
                  <th className="px-4 py-1.5 text-right font-medium">Saat</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-exchange-border/40">
                    <td className="px-4 py-1.5 font-medium">{t.symbol}</td>
                    <td className="px-4 py-1.5">
                      <span
                        className={cn(
                          'font-bold uppercase',
                          t.side === 'buy' ? 'text-exchange-buy' : 'text-exchange-sell',
                        )}
                      >
                        {t.side === 'buy' ? 'Al' : 'Sat'}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono">
                      {formatPrice(t.price)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono">
                      {formatNumber(t.quantity, 8)} {t.symbol.replace('USDT', '')}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono">
                      {formatNumber(t.quantity * t.price, 2)} USDT
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-exchange-muted">
                      {formatTime(t.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}