import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  calculateLiquidationPrice,
  calculatePnl,
  calculateRoe,
  getRiskLevel,
  isLiquidated,
  type RiskLevel,
} from '@/engine/calculations'
import { getMarkPrice } from '@/engine/markPrice'
import { useRiskParams } from '@/hooks/useRiskParams'
import { useTradeStore } from '@/store/tradeStore'
import { cn, formatNumber, formatPnl, formatPrice } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

interface Props {
  /** Per-symbol live close prices from the dedicated `@ticker` streams. */
  livePrices: Record<string, number>
}

function PnlCell({ pnl, roe }: { pnl: number; roe: number }) {
  const prevPnlRef = useRef(pnl)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    const prev = prevPnlRef.current
    prevPnlRef.current = pnl
    if (pnl === prev) return
    setFlash(pnl > prev ? 'up' : 'down')
    const t = window.setTimeout(() => setFlash(null), 400)
    return () => window.clearTimeout(t)
  }, [pnl])

  return (
    <td className="relative px-3 py-2 text-right font-mono font-semibold">
      <AnimatePresence>
        {flash && (
          <motion.span
            initial={{ opacity: 0.4 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className={cn(
              'pointer-events-none absolute inset-0 rounded',
              flash === 'up' ? 'bg-exchange-buy/70' : 'bg-exchange-sell/70',
            )}
          />
        )}
      </AnimatePresence>
      <span className={cn('relative', pnl >= 0 ? 'text-exchange-buy' : 'text-exchange-sell')}>
        {formatPnl(pnl)} ({formatPnl(roe)}%)
      </span>
    </td>
  )
}

const RISK_CHIP: Record<RiskLevel, { label: string; cls: string }> = {
  safe: { label: 'Güvenli', cls: 'bg-exchange-buy/10 text-exchange-buy' },
  watch: { label: 'İzle', cls: 'bg-exchange-yellow/15 text-exchange-yellow' },
  'margin-call': { label: 'Margin Call', cls: 'bg-exchange-sell/15 text-exchange-sell' },
  liquidating: { label: 'Liq', cls: 'bg-exchange-sell text-white' },
}

export function PositionList({ livePrices }: Props) {
  const positions = useTradeStore((s) => s.positions)
  const closePosition = useTradeStore((s) => s.closePosition)
  const risk = useRiskParams()

  if (positions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 py-10 text-sm text-exchange-muted">
        <span>No open positions.</span>
        <span className="text-xs">Go long or short from the order panel.</span>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] text-sm">
        <thead>
          <tr className="border-b border-exchange-border text-xs text-exchange-muted">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-3 py-2 text-left font-medium">Side</th>
            <th className="px-3 py-2 text-right font-medium">Entry</th>
            <th className="px-3 py-2 text-right font-medium">Mark</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
            <th className="px-3 py-2 text-right font-medium">Lev</th>
            <th className="px-3 py-2 text-right font-medium">Liquidation</th>
            <th className="px-3 py-2 text-right font-medium">TP / SL</th>
            <th className="px-3 py-2 text-right font-medium">PnL (ROE)</th>
            {/* Kapat kolonu mobilde yatay kaydırsa da ekranda kalır */}
            <th className="sticky right-0 bg-exchange-bg px-3 py-2 text-right font-medium" />
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => {
            // Mark price: derived at render time from the central livePrices
            // map (falls back to the entry price until the first tick arrives),
            // so PnL / ROE recompute on every feed update.
            const live = livePrices[pos.symbol]
            const price = live && live > 0 ? live : pos.entryPrice
            // Görüntülenen mark fiyat medyandır (tek fitil rozeti oynatmaz).
            const mark = live && live > 0 ? getMarkPrice(pos.symbol, live) : pos.entryPrice
            const pnl = calculatePnl(pos, price)
            const roe = calculateRoe(pos, price)
            const liq = calculateLiquidationPrice(
              pos.entryPrice,
              pos.leverage,
              pos.side,
              risk.maintenanceMarginRate,
            )
            const liquidated = isLiquidated(pos, mark, risk.maintenanceMarginRate)
            const level = getRiskLevel(
              pos,
              mark,
              risk.warnLossFrac,
              risk.criticalLossFrac,
              risk.maintenanceMarginRate,
            )
            const chip = RISK_CHIP[level]

            return (
              <tr
                key={pos.id}
                className={cn(
                  'border-b border-exchange-border/60',
                  liquidated && 'opacity-50',
                )}
              >
                <td className="px-3 py-2 font-semibold">{pos.symbol}</td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap items-center gap-1">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-bold uppercase',
                        pos.side === 'long'
                          ? 'bg-exchange-buy/10 text-exchange-buy'
                          : 'bg-exchange-sell/10 text-exchange-sell',
                      )}
                    >
                      {pos.side}
                    </span>
                    {pos.mode === 'futures' && (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-extrabold uppercase',
                          chip.cls,
                        )}
                        title={
                          level === 'margin-call'
                            ? 'Kritik teminat uyarısı aktif'
                            : level === 'watch'
                              ? 'Teminat erimesi izleniyor'
                              : level === 'liquidating'
                                ? 'Likidasyon bölgesi'
                                : 'Teminat sağlıklı'
                        }
                      >
                        {chip.label}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatPrice(pos.entryPrice)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatPrice(price)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatNumber(pos.quantity, 6)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {pos.mode === 'futures' ? `${pos.leverage}x` : '1x'}
                  {pos.mode === 'futures' && (
                    <span className="ml-1 rounded bg-exchange-surface px-1 py-0.5 align-middle font-sans text-[10px] font-bold text-exchange-muted">
                      {(pos.marginMode ?? 'isolated') === 'isolated' ? 'İzole' : 'Çapraz'}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-exchange-yellow">
                  {formatPrice(liq)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {pos.tpPrice || pos.slPrice ? (
                    <span className="text-xs">
                      <span className="text-exchange-buy">{pos.tpPrice ? formatPrice(pos.tpPrice) : '—'}</span>
                      <span className="text-exchange-muted"> / </span>
                      <span className="text-exchange-sell">{pos.slPrice ? formatPrice(pos.slPrice) : '—'}</span>
                    </span>
                  ) : (
                    <span className="text-exchange-muted">—</span>
                  )}
                </td>
                <PnlCell pnl={pnl} roe={roe} />
                <td className="sticky right-0 bg-exchange-bg px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => closePosition(pos.id, price)}
                  >
                    Close
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}