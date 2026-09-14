import { useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBinanceKlines } from '@/hooks/useBinanceKlines'
import { useAllTickers } from '@/hooks/useAllTickers'
import { useLivePrices } from '@/hooks/useLivePrices'
import { useTradeStore } from '@/store/tradeStore'
import { useOrderStore } from '@/store/orderStore'
import { useToastStore } from '@/store/toastStore'
import {
  calculateLiquidationPrice,
  isLiquidated,
  marginCallDistancePct,
  MARGIN_CALL_THRESHOLD_PCT,
  MARGIN_CALL_THROTTLE_MS,
} from '@/engine/calculations'
import { cn, formatNumber, formatPrice } from '@/lib/utils'
import { DEFAULT_SYMBOL } from '@/lib/constants'
import type { TradingMode } from '@/types'
import { TradingChart } from '@/components/chart/TradingChart'
import { TradingPanel } from '@/components/trading/TradingPanel'
import { PairSelector } from '@/components/trading/PairSelector'
import { PositionList } from '@/components/trading/PositionList'
import { TradeHistory } from '@/components/trading/TradeHistory'

export function TradeScreen({ mode }: { mode: TradingMode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const symbol = searchParams.get('symbol') ?? DEFAULT_SYMBOL

  const balance = useTradeStore((s) => s.balance)
  const positions = useTradeStore((s) => s.positions)
  const spotBalances = useTradeStore((s) => s.spotBalances)
  const spotPositions = useTradeStore((s) => s.spotPositions)
  const forceLiquidate = useTradeStore((s) => s.forceLiquidate)
  const closeSpotPosition = useTradeStore((s) => s.closeSpotPosition)
  const pushToast = useToastStore((s) => s.push)
  const pendingOrders = useOrderStore((s) => s.pendingOrders)

  const { tickers, status: marketStatus } = useAllTickers()

  // Lightweight per-symbol streams: the active pair, every open position and
  // held spot coins each get their own dedicated `@ticker` socket feeding the
  // central `livePrices` number map — the single source for the header, the
  // chart panel and the Mark column. Never routed through the heavy market feed.
  const tradedSymbols = useMemo(
    () =>
      Array.from(
        new Set([
          symbol.toUpperCase(),
          ...positions.map((p) => p.symbol),
          ...spotPositions.map((p) => p.symbol),
          ...Object.entries(spotBalances)
            .filter(([, qty]) => qty > 0)
            .map(([coin]) => `${coin}USDT`),
        ]),
      ).slice(0, 40),
    [symbol, positions, spotPositions, spotBalances],
  )
  const livePrices = useLivePrices(tradedSymbols)

  // Full 24h row (change %, volume) for the selected pair.
  const ticker = tickers[symbol] ?? null
  const livePrice = livePrices[symbol]
  const { klines, isLoading, error } = useBinanceKlines(mode, symbol, '1m')

  const handleSymbolChange = (next: string) => {
    setSearchParams({ symbol: next }, { replace: true })
  }

  // Market-data fallback — when klines cannot be loaded (e.g. the pair was
  // delisted or is suspended on Binance) switch the user to the default pair.
  useEffect(() => {
    if (!error) return
    pushToast({
      message: `${symbol} için piyasa verisi alınamadı. Otomatik olarak BTCUSDT yükleniyor.`,
      tone: 'error',
    })
    if (symbol.toUpperCase() !== DEFAULT_SYMBOL) {
      handleSymbolChange(DEFAULT_SYMBOL)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  // Auto-liquidation watchdog — all open futures positions, tracked against
  // their own live price from the dedicated per-symbol feed. Prices are
  // ignored while no market feed is live to avoid fake liquidations.
  useEffect(() => {
    if (marketStatus !== 'live') return
    for (const pos of positions) {
      if (pos.mode !== 'futures') continue
      const live = livePrices[pos.symbol]
      if (!live || live <= 0) continue
      if (isLiquidated(pos, live)) {
        const liq = calculateLiquidationPrice(pos.entryPrice, pos.leverage, pos.side)
        forceLiquidate(pos.id, liq)
      }
    }
  }, [livePrices, positions, forceLiquidate, marketStatus])

  // Margin-call watchdog — when the live price gets within a small %, of the
  // liquidation price, warn the user. Throttled: only one toast per position
  // per MARGIN_CALL_THROTTLE_MS window so it never spams every second.
  const lastMarginCallAt = useRef<Record<string, number>>({})

  useEffect(() => {
    if (marketStatus !== 'live') return
    const now = Date.now()
    for (const pos of positions) {
      if (pos.mode !== 'futures') continue
      const live = livePrices[pos.symbol]
      if (!live || live <= 0) continue
      const distancePct = marginCallDistancePct(pos, live)
      if (!(distancePct < MARGIN_CALL_THRESHOLD_PCT)) continue
      const lastAt = lastMarginCallAt.current[pos.id] ?? 0
      if (now - lastAt < MARGIN_CALL_THROTTLE_MS) continue
      lastMarginCallAt.current[pos.id] = now
      pushToast({
        message: `⚠️ DİKKAT: ${pos.symbol} pozisyonunuz likidasyon riskine yaklaştı! Marjin ekleyin veya pozisyonu küçültün.`,
        tone: 'error',
      })
    }
  }, [livePrices, positions, marketStatus, pushToast])

  // TP/SL watchdog — futures positions carrying a take-profit or stop-loss
  // price are closed as soon as the live mark/last price crosses them,
  // regardless of what the server-side demo would do (this app is client-side).
  useEffect(() => {
    if (marketStatus !== 'live') return
    for (const pos of positions) {
      if (pos.mode !== 'futures') continue
      if (!pos.tpPrice && !pos.slPrice) continue
      const live = livePrices[pos.symbol]
      if (!live || live <= 0) continue
      const isLong = pos.side === 'long'
      if (pos.slPrice && (isLong ? live <= pos.slPrice : live >= pos.slPrice)) {
        useTradeStore.getState().closePosition(pos.id, live, 'tp_sl')
        continue
      }
      if (pos.tpPrice && (isLong ? live >= pos.tpPrice : live <= pos.tpPrice)) {
        useTradeStore.getState().closePosition(pos.id, live, 'tp_sl')
      }
    }
  }, [livePrices, positions, marketStatus])

  // Spot TP/SL watchdog — spot lots bought with Oto-Kar Al / Oto-Zarar Durdur
  // are auto-sold back to USDT the moment the live price crosses the target.
  useEffect(() => {
    if (marketStatus !== 'live') return
    for (const p of spotPositions) {
      const live = livePrices[p.symbol]
      if (!live || live <= 0) continue
      if (p.slPrice && live <= p.slPrice) {
        closeSpotPosition(p.id, live)
        pushToast({
          message: `${p.symbol} — Oto-Zarar Durdur tetiklendi (${p.slPrice}).`,
          tone: 'info',
        })
        continue
      }
      if (p.tpPrice && live >= p.tpPrice) {
        closeSpotPosition(p.id, live)
        pushToast({
          message: `${p.symbol} — Oto-Kar Al tetiklendi (${p.tpPrice}).`,
          tone: 'success',
        })
      }
    }
  }, [livePrices, spotPositions, marketStatus, closeSpotPosition, pushToast])

  // Pending-order watchdog — fires limit / stop / OCO legs and trails the
  // stopping orders as the market moves, all against the dedicated per-symbol
  // live price feed.
  useEffect(() => {
    if (marketStatus !== 'live') return
    for (const order of pendingOrders) {
      const live = livePrices[order.symbol]
      if (!live || live <= 0) continue
      const buy = order.side === 'buy' || order.side === 'long'
      if (
        order.orderType === 'stop-market' ||
        order.orderType === 'stop-limit' ||
        order.leg === 'stop'
      ) {
        if (buy ? live >= order.stopPrice! : live <= order.stopPrice!) {
          useOrderStore.getState().fireOrder(order.id, live)
        }
      } else if (order.leg === 'limit') {
        if (buy ? live <= order.entryPrice : live >= order.entryPrice) {
          useOrderStore.getState().fireOrder(order.id, live)
        }
      } else if (order.orderType === 'limit') {
        if (buy ? live <= order.entryPrice : live >= order.entryPrice) {
          useOrderStore.getState().fireOrder(order.id, live)
        }
      } else if (order.orderType === 'trailing') {
        const peak = order.peakPrice || live
        const np = buy ? Math.max(peak, live) : Math.min(peak, live)
        const cb = order.cbRate || 0.5
        if (np !== peak) {
          useOrderStore.setState((s) => ({
            pendingOrders: s.pendingOrders.map((p) =>
              p.id === order.id ? { ...p, peakPrice: np } : p,
            ),
          }))
        }
        if (buy ? live <= np * (1 - cb / 100) : live >= np * (1 + cb / 100)) {
          useOrderStore.getState().fireOrder(order.id, live)
        }
      }
    }
  }, [livePrices, pendingOrders, marketStatus])

  const change = ticker?.changePercent24h
  const stats = useMemo(
    () => [
      { label: '24s Fark', value: ticker ? `${change! >= 0 ? '+' : ''}${formatNumber(change!, 2)}%` : '—', positive: change! >= 0 },
      { label: '24s En Yüksek', value: ticker ? formatPrice(Math.max(ticker.price, ticker.price * (1 + Math.abs(change!) / 100))) : '—' },
      { label: '24s En Düşük', value: ticker ? formatPrice(Math.min(ticker.price, ticker.price * (1 - Math.abs(change!) / 100))) : '—' },
      { label: '24s Hacim', value: ticker ? `${formatNumber(ticker.volume24h, 0)} ${symbol.replace('USDT', '')}` : '—' },
    ],
    [ticker, change, symbol],
  )

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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto md:overflow-hidden">
      <main className="flex min-h-0 flex-col md:grid md:min-h-0 md:flex-1 md:grid-cols-[1fr_360px]">
        {/* Left: chart + positions */}
        <section className="flex min-h-0 flex-col md:border-r md:border-exchange-border">
          <div className="flex items-center justify-between border-b border-exchange-border px-4 py-2">
            <div className="flex items-center gap-3">
              <PairSelector
                symbol={symbol}
                onSymbolChange={handleSymbolChange}
                tickers={tickers}
                live={marketStatus === 'live'}
              />
              <span className="font-mono text-xl font-bold text-exchange-text sm:text-2xl">
                {livePrice ? formatPrice(livePrice) : '—'}
              </span>
              {ticker && (
                <span
                  className={cn(
                    'font-mono text-sm font-semibold',
                    change! >= 0 ? 'text-exchange-buy' : 'text-exchange-sell',
                  )}
                >
                  {change! >= 0 ? '+' : ''}
                  {formatNumber(change!, 2)}%
                </span>
              )}
            </div>
            <div className="hidden items-center gap-4 sm:flex">
              {stats.map((s) => (
                <div key={s.label} className="text-right">
                  <div className="text-[10px] uppercase text-exchange-muted">{s.label}</div>
                  <div className={cn('font-mono text-xs', s.positive === undefined ? 'text-exchange-text' : s.positive ? 'text-exchange-buy' : 'text-exchange-sell')}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative h-[360px] flex-none sm:h-[420px] md:h-auto md:min-h-[320px] md:flex-1">
            {isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-exchange-muted">
                Loading chart data…
              </div>
            ) : error ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-exchange-sell">
                <span>Failed to load market data</span>
                <span className="text-xs text-exchange-muted">{error}</span>
              </div>
            ) : (
              <TradingChart klines={klines} className="h-full w-full" />
            )}
          </div>

          <div className="border-t border-exchange-border">
            <div className="flex items-center justify-between px-4 pt-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-exchange-muted">
                {mode === 'spot' ? 'Spot Varlıklar' : 'Açık Pozisyonlar'}
              </span>
              <span className="text-xs text-exchange-muted">
                {formatNumber(balance, 2)} USDT kullanılabilir
              </span>
            </div>
            {mode === 'spot' ? (
              <>
                {spotPositions.length > 0 && (
                  <div className="border-b border-exchange-border/40 px-4 pt-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-exchange-muted">
                      Oto Emirler (TP / SL)
                    </div>
                    {spotPositions.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-3 py-1.5 text-xs"
                      >
                        <span className="font-mono font-semibold text-exchange-text">
                          {p.symbol}
                        </span>
                        <span className="text-exchange-muted">
                          {formatNumber(p.quantity, 6)} adet
                        </span>
                        <span className="font-mono">
                          <span className="text-exchange-buy">
                            {p.tpPrice ? formatPrice(p.tpPrice) : '—'}
                          </span>
                          <span className="text-exchange-muted"> / </span>
                          <span className="text-exchange-sell">
                            {p.slPrice ? formatPrice(p.slPrice) : '—'}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            closeSpotPosition(p.id, livePrices[p.symbol] ?? p.entryPrice)
                          }
                          className="shrink-0 font-semibold text-exchange-yellow hover:underline"
                        >
                          İptal
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {holdings.length === 0 ? (
                  <div className="px-4 py-4 text-center text-xs text-exchange-muted">
                    Henüz coin satın alınmadı. Alt taraftaki panel ile BTC, ETH ve
                    diğer coinlerden alıp cüzdanınızda tutabilirsiniz.
                  </div>
                ) : (
                <div className="overflow-x-auto px-4 py-2">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-exchange-border text-exchange-muted">
                        <th className="py-1.5 text-left font-medium">Varlık</th>
                        <th className="py-1.5 text-right font-medium">Miktar</th>
                        <th className="py-1.5 text-right font-medium">Fiyat (USDT)</th>
                        <th className="py-1.5 text-right font-medium">Değer (USDT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((h) => (
                        <tr key={h.coin} className="border-b border-exchange-border/40">
                          <td className="py-1.5 font-medium">
                            <div className="flex items-center gap-2">
                              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-exchange-buy/10 text-[10px] font-bold text-exchange-buy">
                                {h.coin.slice(0, 1)}
                              </span>
                              {h.coin}
                            </div>
                          </td>
                          <td className="py-1.5 text-right font-mono">{formatNumber(h.qty, 6)}</td>
                          <td className="py-1.5 text-right font-mono">
                            {h.price > 0 ? formatPrice(h.price) : '—'}
                          </td>
                          <td className="py-1.5 text-right font-mono">
                            {formatNumber(h.value, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
                </>
            ) : (
              <PositionList livePrices={livePrices} />
            )}
          </div>
        </section>

        {/* Right: trading panel */}
        <aside className="min-h-0 border-t border-exchange-border bg-exchange-surface md:border-t-0">
          <TradingPanel
            key={symbol}
            ticker={ticker}
            mode={mode}
            balance={balance}
            marketPrice={livePrices[symbol]}
          />
        </aside>
      </main>

      <TradeHistory mode={mode} />
    </div>
  )
}