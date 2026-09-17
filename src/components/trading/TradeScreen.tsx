import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useBinanceKlines } from '@/hooks/useBinanceKlines'
import { useUnifiedTickers } from '@/hooks/useUnifiedTickers'
import { useVirtualKlines } from '@/hooks/useVirtualKlines'
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
import { cn, formatCompact, formatNumber, formatPrice } from '@/lib/utils'
import { boll, ema, lastDefined, sma } from '@/lib/indicators'
import { DEFAULT_SYMBOL } from '@/lib/constants'
import type { Interval } from '@/types'
import type { TradingMode } from '@/types'
import { TradingChart, type ChartIndicators } from '@/components/chart/TradingChart'
import { TradingPanel, type PanelSide } from '@/components/trading/TradingPanel'
import { VirtualTradePanel } from '@/components/markets/VirtualTradePanel'
import { MobileTradeTabs } from '@/components/trading/MobileTradeTabs'
import { Button } from '@/components/ui/Button'
import { PairSelector } from '@/components/trading/PairSelector'
import { PositionList } from '@/components/trading/PositionList'
import { TradeHistory } from '@/components/trading/TradeHistory'
import { CoinNewsPanel } from '@/components/trading/CoinNewsPanel'

const TIMEFRAMES: { v: Interval; l: string }[] = [
  { v: '1m', l: '1m' },
  { v: '5m', l: '5m' },
  { v: '15m', l: '15m' },
  { v: '1h', l: '1H' },
  { v: '4h', l: '4H' },
  { v: '1d', l: '1D' },
  { v: '1w', l: '1W' },
]

const INTERVAL_KEY = 'deniztradx_chart_interval'
const INDICATORS_KEY = 'deniztradx_chart_indicators'

const DEFAULT_INDICATORS: ChartIndicators = { ma: false, ema: false, boll: false, volume: true }

function readStoredInterval(): Interval {
  try {
    const raw = localStorage.getItem(INTERVAL_KEY)
    if (TIMEFRAMES.some((t) => t.v === raw)) return raw as Interval
  } catch {
    // gizli mod — varsayılan
  }
  return '1m'
}

function readStoredIndicators(): ChartIndicators {
  try {
    const raw = localStorage.getItem(INDICATORS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChartIndicators>
      return {
        ma: parsed.ma === true,
        ema: parsed.ema === true,
        boll: parsed.boll === true,
        volume: parsed.volume !== false,
      }
    }
  } catch {
    // gizli mod — varsayılan
  }
  return DEFAULT_INDICATORS
}

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

  const { tickers, virtualSymbols, status: marketStatus } = useUnifiedTickers()

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

  // Grafik: zaman dilimi + indikatör seçimleri cihazda saklanır.
  const [interval, setIntervalState] = useState<Interval>(readStoredInterval)
  const [indicators, setIndicatorsState] = useState<ChartIndicators>(readStoredIndicators)

  const setInterval = (v: Interval) => {
    setIntervalState(v)
    try {
      localStorage.setItem(INTERVAL_KEY, v)
    } catch {
      // yoksay
    }
  }

  const toggleIndicator = (key: keyof ChartIndicators) => {
    setIndicatorsState((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try {
        localStorage.setItem(INDICATORS_KEY, JSON.stringify(next))
      } catch {
        // yoksay
      }
      return next
    })
  }

  // Mobil emir girişi: grafik altında yalnızca Al/Sat butonları durur;
  // formun tamamı bottom sheet içinde açılır (Binance mobil düzeni).
  // `null` = kapalı, aksi halde sheet'in açılış yönü.
  const [sheetSide, setSheetSide] = useState<PanelSide | null>(null)

  // Sanal coinlerde (ENTES, V-XAU…) grafik + işlem sanal altyapıdan gelir;
  // gerçek coinlerde Binance akışı aynen korunur.
  const isVirtual = virtualSymbols.has(symbol.toUpperCase())

  // Full 24h row (change %, volume) for the selected pair.
  const ticker = tickers[symbol] ?? null
  const livePrice = livePrices[symbol] ?? ticker?.price
  const { klines, isLoading, error } = useBinanceKlines(mode, symbol, interval, !isVirtual)
  const {
    klines: virtualKlines,
    isLoading: virtualLoading,
    error: virtualError,
  } = useVirtualKlines(isVirtual ? symbol : '', interval)
  const shownKlines = isVirtual ? virtualKlines : klines
  const chartLoading = isVirtual ? virtualLoading : isLoading
  const chartError = isVirtual ? virtualError : error

  const handleSymbolChange = (next: string) => {
    setSearchParams({ symbol: next }, { replace: true })
  }

  // Market-data fallback — when klines cannot be loaded (e.g. the pair was
  // delisted or is suspended on Binance) switch the user to the default pair.
  // Sanal coinlerde Binance hatası aranmaz (grafikleri kendi tablomuzdan gelir).
  useEffect(() => {
    if (isVirtual || !error) return
    pushToast({
      message: `${symbol} için piyasa verisi alınamadı. Otomatik olarak BTCUSDT yükleniyor.`,
      tone: 'error',
    })
    if (symbol.toUpperCase() !== DEFAULT_SYMBOL) {
      handleSymbolChange(DEFAULT_SYMBOL)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, isVirtual])

  // Sanal coinlerde vadeli kontrat yoktur — vadeli rotası spot'a yönlenir.
  const navigate = useNavigate()
  useEffect(() => {
    if (isVirtual && mode === 'futures') {
      navigate(`/spot?symbol=${symbol}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtual, mode])

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

  // Grafik lejantı: açık indikatörlerin son değerleri.
  const legendItems = useMemo(() => {
    if (shownKlines.length === 0) return []
    const closes = shownKlines.map((k) => k.close)
    const items: { color: string; text: string }[] = []
    if (indicators.ma) {
      const fast = lastDefined(sma(closes, 7))
      const slow = lastDefined(sma(closes, 25))
      if (fast !== null) items.push({ color: '#00e5ff', text: `MA7 ${formatPrice(fast)}` })
      if (slow !== null) items.push({ color: '#8b95a1', text: `MA25 ${formatPrice(slow)}` })
    }
    if (indicators.ema) {
      const fast = lastDefined(ema(closes, 12))
      const slow = lastDefined(ema(closes, 26))
      if (fast !== null) items.push({ color: '#00c853', text: `EMA12 ${formatPrice(fast)}` })
      if (slow !== null) items.push({ color: '#ff3d00', text: `EMA26 ${formatPrice(slow)}` })
    }
    if (indicators.boll) {
      const basis = lastDefined(boll(closes, 20, 2).basis)
      if (basis !== null) items.push({ color: '#f1f5f9', text: `BOLL ${formatPrice(basis)}` })
    }
    if (indicators.volume) {
      const last = shownKlines[shownKlines.length - 1]
      items.push({ color: '#8b95a1', text: `Hacim ${formatCompact(last.volume)}` })
    }
    return items
  }, [shownKlines, indicators])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-x-clip overflow-y-auto md:overflow-hidden">
      <main className="flex min-h-0 w-full min-w-0 max-w-full flex-col md:min-h-0 md:flex-1 md:flex-row md:overflow-hidden">
        {/* Left: chart + positions */}
        <section className="flex min-h-0 w-full min-w-0 max-w-full flex-col md:flex-1 md:overflow-y-auto md:border-r md:border-exchange-border">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-exchange-border px-3 py-2 sm:px-4">
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:gap-3">
              <PairSelector
                symbol={symbol}
                onSymbolChange={handleSymbolChange}
                tickers={tickers}
                live={marketStatus === 'live'}
                mode={mode}
                virtualSymbols={virtualSymbols}
              />
              <span className="min-w-0 flex-1 basis-24 truncate font-mono text-lg font-bold text-exchange-text sm:flex-none sm:basis-auto sm:text-2xl">
                {livePrice ? formatPrice(livePrice) : '—'}
              </span>
              {ticker && (
                <span
                  className={cn(
                    'whitespace-nowrap font-mono text-xs font-semibold sm:text-sm',
                    change! >= 0 ? 'text-exchange-buy' : 'text-exchange-sell',
                  )}
                >
                  {change! >= 0 ? '+' : ''}
                  {formatNumber(change!, 2)}%
                </span>
              )}
            </div>
            <div className="ml-auto hidden items-center gap-4 sm:flex">
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

          <CoinNewsPanel symbol={symbol} />

          {/* Zaman dilimi + indikatör araç çubuğu (masaüstü: haplar).
              Mobilde haplar yerine tek dropdown kullanılır (aşağıda). */}
          <div className="hidden items-center gap-1.5 border-b border-exchange-border px-2 py-1.5 sm:flex sm:px-3">
            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.v}
                  type="button"
                  onClick={() => setInterval(tf.v)}
                  aria-pressed={interval === tf.v}
                  className={cn(
                    'min-h-[2rem] shrink-0 rounded-md px-2.5 text-xs font-bold transition-colors',
                    interval === tf.v
                      ? 'bg-exchange-yellow/15 text-exchange-yellow'
                      : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-text',
                  )}
                >
                  {tf.l}
                </button>
              ))}
            </div>
            <IndicatorMenu indicators={indicators} onToggle={toggleIndicator} />
          </div>

          {/* Mobil araç çubuğu: tek zaman-dilimi menüsü + indikatörler.
              İki öğe de sabit genişlikli/sarmalanır — taşma ve çakışma yok. */}
          <div className="flex items-center gap-2 border-b border-exchange-border px-3 py-1.5 sm:hidden">
            <TimeframeMenu interval={interval} onSelect={setInterval} />
            <IndicatorMenu indicators={indicators} onToggle={toggleIndicator} />
          </div>

          <div className="relative h-[220px] w-full max-w-full flex-none sm:h-[340px] md:h-[500px]">
            {legendItems.length > 0 && !chartLoading && !chartError && (
              <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap gap-x-2.5 gap-y-0.5">
                {legendItems.map((item) => (
                  <span
                    key={item.text}
                    className="flex items-center gap-1 whitespace-nowrap font-mono text-[10px] font-semibold"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-exchange-text">{item.text}</span>
                  </span>
                ))}
              </div>
            )}
            {chartLoading ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-exchange-muted">
                Loading chart data…
              </div>
            ) : chartError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-exchange-sell">
                <span>Failed to load market data</span>
                <span className="text-xs text-exchange-muted">{chartError}</span>
              </div>
            ) : (
              <TradingChart klines={shownKlines} indicators={indicators} className="h-full w-full" />
            )}
          </div>

          {/* Mobil emir çubuğu: yalnızca Al/Sat. Form sheet içinde. */}
          <div className="grid grid-cols-2 gap-2 px-3 py-2 sm:px-4 md:hidden">
            <Button
              variant="buy"
              size="md"
              className="w-full whitespace-nowrap font-bold"
              onClick={() => setSheetSide(mode === 'spot' ? 'buy' : 'long')}
            >
              {mode === 'spot' ? 'Al' : 'Long'}
            </Button>
            <Button
              variant="sell"
              size="md"
              className="w-full whitespace-nowrap font-bold"
              onClick={() => setSheetSide(mode === 'spot' ? 'sell' : 'short')}
            >
              {mode === 'spot' ? 'Sat' : 'Short'}
            </Button>
          </div>

          <MobileTradeTabs mode={mode} livePrices={livePrices} />

          <div className="hidden border-t border-exchange-border md:block">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2 sm:px-4">
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
                  <div className="border-b border-exchange-border/40 px-3 pt-2 sm:px-4">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-exchange-muted">
                      Oto Emirler (TP / SL)
                    </div>
                    {spotPositions.map((p) => (
                      <div
                        key={p.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs"
                      >
                        <span className="shrink-0 font-mono font-semibold text-exchange-text">
                          {p.symbol}
                        </span>
                        <span className="min-w-0 truncate text-exchange-muted">
                          {formatNumber(p.quantity, 6)} adet
                        </span>
                        <span className="whitespace-nowrap font-mono">
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
                          className="ml-auto shrink-0 font-semibold text-exchange-yellow hover:underline"
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
                <div className="overflow-x-auto px-3 py-2 sm:px-4">
                  <table className="w-full min-w-[26rem] text-xs">
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

        {/* Right: trading panel (yalnızca masaüstü — mobilde bottom sheet kullanılır).
            Sanal sembolde AMM paneli, gerçekte standart panel. */}
        <aside className="hidden max-w-full border-t border-exchange-border bg-exchange-surface md:block md:h-full md:w-[360px] md:shrink-0 md:overflow-y-auto md:border-t-0 md:border-l">
          {isVirtual ? (
            <VirtualTradePanel key={`v-${symbol}`} symbol={symbol} />
          ) : (
            <TradingPanel
              key={symbol}
              ticker={ticker}
              mode={mode}
              balance={balance}
              marketPrice={livePrices[symbol]}
            />
          )}
        </aside>
      </main>

      <div className="hidden md:block">
        <TradeHistory mode={mode} />
      </div>

      {/* Mobil emir sheet'i: formun tamamı burada (Binance mobil düzeni). */}
      <AnimatePresence>
        {sheetSide && (
          <motion.div
            key="order-sheet"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[60] md:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Emir ver"
          >
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setSheetSide(null)}
              aria-hidden
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
              className="absolute inset-x-0 bottom-0 flex max-h-[60dvh] flex-col overflow-hidden rounded-t-2xl border-t border-exchange-border bg-exchange-card pb-safe shadow-2xl"
            >
              <div className="flex shrink-0 justify-center pt-2" aria-hidden>
                <span className="h-1 w-10 rounded-full bg-exchange-border" />
              </div>
              <div className="flex shrink-0 items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1 truncate text-base font-extrabold text-exchange-text">
                  {symbol.replace('USDT', '')}
                  <span className="text-xs font-semibold text-exchange-muted"> / USDT</span>
                </span>
                <span className="shrink-0 font-mono text-sm font-bold text-exchange-text">
                  {livePrice ? formatPrice(livePrice) : '—'}
                </span>
                <button
                  type="button"
                  onClick={() => setSheetSide(null)}
                  aria-label="Kapat"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-exchange-muted hover:bg-exchange-surface hover:text-exchange-text"
                >
                  ✕
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-exchange-border">
                {isVirtual ? (
                  <VirtualTradePanel key={`v-${symbol}`} symbol={symbol} />
                ) : (
                  <TradingPanel
                    key={`${symbol}-${sheetSide}`}
                    ticker={ticker}
                    mode={mode}
                    balance={balance}
                    marketPrice={livePrices[symbol]}
                    initialSide={sheetSide}
                    onSubmitted={() => setSheetSide(null)}
                    showTriggerType={false}
                  />
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Mobil zaman-dilimi menüsü (Binance tarzı tek dropdown): 7 hap yerine
 * mevcut seçimi gösteren kompakt bir buton + açılır liste.
 */
function TimeframeMenu({
  interval,
  onSelect,
}: {
  interval: Interval
  onSelect: (v: Interval) => void
}) {
  const [open, setOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const current = TIMEFRAMES.find((t) => t.v === interval) ?? TIMEFRAMES[0]

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open ])

  return (
    <div ref={scopeRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex min-h-[2.25rem] w-full items-center justify-between gap-2 rounded-lg border px-3 text-sm font-bold transition-colors',
          open
            ? 'border-exchange-yellow/60 bg-exchange-yellow/10 text-exchange-yellow'
            : 'border-exchange-border bg-exchange-surface text-exchange-text',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="shrink-0 text-exchange-muted">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="truncate font-mono">{current.l}</span>
        </span>
        <span className={cn('shrink-0 text-[10px] text-exchange-muted transition-transform', open && 'rotate-180')}>
          ▼
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            role="listbox"
            aria-label="Zaman dilimi"
            className="absolute left-0 top-full z-50 mt-2 w-44 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-exchange-border bg-exchange-card shadow-2xl"
          >
            {TIMEFRAMES.map((tf) => {
              const active = tf.v === interval
              return (
                <button
                  key={tf.v}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onSelect(tf.v)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-exchange-surface',
                    active ? 'bg-exchange-yellow/5' : undefined,
                  )}
                >
                  <span className={cn('font-mono text-sm font-bold', active ? 'text-exchange-yellow' : 'text-exchange-text')}>
                    {tf.l}
                  </span>
                  {active && <span className="text-xs font-extrabold text-exchange-yellow">✓</span>}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const INDICATOR_ROWS: { key: keyof ChartIndicators; label: string; hint: string }[] = [  { key: 'ma', label: 'Hareketli Ortalama', hint: 'MA 7 · 25' },
  { key: 'ema', label: 'Üstel Ortalama', hint: 'EMA 12 · 26' },
  { key: 'boll', label: 'Bollinger Bantları', hint: '20 · 2σ' },
  { key: 'volume', label: 'Hacim', hint: 'mum altı barlar' },
]

function IndicatorMenu({
  indicators,
  onToggle,
}: {
  indicators: ChartIndicators
  onToggle: (key: keyof ChartIndicators) => void
}) {
  const [open, setOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const activeCount = INDICATOR_ROWS.filter((r) => indicators[r.key]).length

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open ])

  return (
    <div ref={scopeRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex min-h-[2rem] items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-bold transition-colors',
          open || activeCount > 0
            ? 'border-exchange-yellow/60 bg-exchange-yellow/10 text-exchange-yellow'
            : 'border-exchange-border text-exchange-muted hover:border-exchange-muted hover:text-exchange-text',
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17l5-6 4 3 7-8" />
          <path d="M17 6h4v4" />
        </svg>
        İndikatörler
        {activeCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-exchange-yellow px-1 text-[10px] font-extrabold leading-none text-black">
            {activeCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            role="menu"
            aria-label="Grafik indikatörleri"
            className="absolute right-0 top-full z-50 mt-2 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-exchange-border bg-exchange-card shadow-2xl"
          >
            <div className="border-b border-exchange-border px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-exchange-muted">
              İndikatör Ekle
            </div>
            {INDICATOR_ROWS.map((row) => {
              const on = indicators[row.key]
              return (
                <button
                  key={row.key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => onToggle(row.key)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-exchange-surface"
                >
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs font-extrabold transition-colors',
                      on
                        ? 'border-exchange-yellow bg-exchange-yellow text-black'
                        : 'border-exchange-border text-transparent',
                    )}
                    aria-hidden
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-exchange-text">
                      {row.label}
                    </span>
                    <span className="block text-[11px] text-exchange-muted">{row.hint}</span>
                  </span>
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}