import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  positionSize,
  type OrderInput,
} from '@/engine/calculations'
import { useTradeStore } from '@/store/tradeStore'
import { useOrderStore, type OrderSpec, type OrderStance } from '@/store/orderStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useToastStore } from '@/store/toastStore'
import { cn, formatNumber, formatPrice } from '@/lib/utils'
import type { OrderType, Ticker, TIF, TradingMode, TriggerType } from '@/types'
import { Button } from '@/components/ui/Button'
import { CustomSelect } from '@/components/ui/CustomSelect'

interface Props {
  ticker: Ticker | null
  mode: TradingMode
  balance: number
  /** Latest market price for the selected coin (all-markets snapshot). */
  marketPrice?: number
  /** Mobil bottom sheet'ten açılışta seçili gelecek yön. Verilmezse moda göre varsayılan. */
  initialSide?: PanelSide
  /** Emir başarıyla gönderildiğinde çağrılır (mobilde sheet'i kapatmak için). */
  onSubmitted?: () => void
}

export type PanelSide = OrderStance

interface OrderDraft {
  symbol: string
  mode: TradingMode
  side: PanelSide
  quantity: number
  entryPrice: number
  leverage: number
}

type OrderDraftSpec = Omit<OrderSpec, 'id' | 'at' | 'filled'>

const currency = 'USDT'

const ORDER_TYPES: OrderType[] = [
  'market',
  'limit',
  'stop-market',
  'stop-limit',
  'trailing',
  'oco',
]

const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  market: 'Piyasa',
  limit: 'Limit',
  'stop-market': 'Stop-Market',
  'stop-limit': 'Stop-Limit',
  trailing: 'İzleyen Stop',
  oco: 'OCO',
}

export function TradingPanel({ ticker, mode, balance, marketPrice, initialSide, onSubmitted }: Props) {
  const spotBalances = useTradeStore((s) => s.spotBalances)
  const confirmOrders = useSettingsStore((s) => s.confirmOrders)
  const place = useOrderStore((s) => s.placeOrder)
  const cancelPendingOrder = useOrderStore((s) => s.cancelPendingOrder)
  const pendingOrders = useOrderStore((s) => s.pendingOrders)
  const pushToast = useToastStore((s) => s.push)

  const coin = ticker?.symbol.replace(/USDT$/i, '') ?? 'BTC'
  const heldCoin = spotBalances[coin] ?? 0

  const [side, setSide] = useState<PanelSide>(initialSide ?? (mode === 'spot' ? 'buy' : 'long'))
  const [leverage, setLeverage] = useState(10)
  const [priceStr, setPriceStr] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmSpec, setConfirmSpec] = useState<OrderDraftSpec | null>(null)
  const priceSymbolRef = useRef<string | null>(null)

  const [orderType, setOrderType] = useState<OrderType>('limit')
  const [stopStr, setStopStr] = useState('')
  const [tpStr, setTpStr] = useState('')
  const [slStr, setSlStr] = useState('')
  const [triggerType, setTriggerType] = useState<TriggerType>('last')
  const [reduceOnly, setReduceOnly] = useState(false)
  const [postOnly, setPostOnly] = useState(false)
  const [tif, setTif] = useState<TIF>('GTC')
  const [cbStr, setCbStr] = useState('')
  const priceDirtyRef = useRef(false)

  // Keep the Price input in sync with the selected coin's live market price.
  // The field tracks the market on every tick UNTIL the user types into it;
  // a manual edit pauses the sync (per coin) so it is never clobbered. The
  // user can resume live tracking by clearing the field or switching coin.
  useEffect(() => {
    const source = ticker?.price ?? marketPrice ?? 0
    if (source <= 0) return
    const symbol = ticker?.symbol ?? null
    if (priceSymbolRef.current !== symbol) {
      priceSymbolRef.current = symbol
      priceDirtyRef.current = false
      setPriceStr(String(source))
    } else if (!priceDirtyRef.current) {
      setPriceStr(String(source))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, marketPrice])

  const price = parseFloat(priceStr)
  const amount = parseFloat(amountStr)
  const stopPrice = parseFloat(stopStr)
  const tpValue = parseFloat(tpStr)
  const slValue = parseFloat(slStr)
  const cbValue = parseFloat(cbStr) || 0.5

  const markPrice = marketPrice || ticker?.price || price || 0
  const isBuy = mode === 'spot' ? side === 'buy' : side === 'long'

  const showPrice = orderType === 'limit' || orderType === 'stop-limit' || orderType === 'oco'
  const showStop =
    orderType === 'stop-limit' || orderType === 'stop-market' || orderType === 'oco'
  const showTrailingRate = orderType === 'trailing'

  const effPrice =
    orderType === 'market' || orderType === 'stop-market' || orderType === 'trailing'
      ? markPrice
      : price

  const draft = useMemo<OrderDraft | null>(() => {
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(effPrice) || effPrice <= 0) {
      return null
    }
    return {
      symbol: ticker?.symbol ?? 'BTCUSDT',
      mode,
      side,
      quantity: amount / effPrice,
      entryPrice: effPrice,
      leverage: mode === 'futures' ? leverage : 1,
    }
  }, [amount, effPrice, side, mode, leverage, ticker])

  const futuresSize = draft && mode === 'futures'
    ? positionSize(balance, draft as OrderInput)
    : null

  const maxValue = useMemo(() => {
    if (!effPrice || effPrice <= 0) return 0
    return mode === 'futures' ? (balance * leverage) / effPrice : 0
  }, [balance, effPrice, leverage, mode])

  const maxNotional = useMemo(() => {
    if (mode === 'spot') {
      const base = isBuy ? balance : heldCoin * (effPrice || 1)
      return base > 0 ? base : 0
    }
    return balance * leverage
  }, [balance, heldCoin, effPrice, leverage, mode, isBuy])

  const setPct = useCallback(
    (k: number) => {
      const base = maxNotional
      if (base <= 0) return
      setAmountStr(base * k / 100 > 0 ? (base * k / 100).toFixed(2) : '')
    },
    [maxNotional],
  )

  const buildOrder = (): OrderDraftSpec | { k: 'amount' | 'price' | 'stop' } => {
    const priceForEntry = effPrice
    if (!Number.isFinite(amount) || amount <= 0) return { k: 'amount' }
    if (
      (orderType === 'limit' || orderType === 'stop-limit' || orderType === 'oco') &&
      (!Number.isFinite(price) || price <= 0)
    ) {
      return { k: 'price' }
    }
    if (
      (orderType === 'stop-market' || orderType === 'stop-limit' || orderType === 'oco') &&
      (!Number.isFinite(stopPrice) || stopPrice <= 0)
    ) {
      return { k: 'stop' }
    }
    return {
      symbol: ticker?.symbol ?? 'BTCUSDT',
      mode,
      side,
      orderType,
      quantity: amount / priceForEntry,
      entryPrice: orderType === 'stop-market' || orderType === 'trailing' ? markPrice || priceForEntry : priceForEntry,
      stopPrice: showStop ? stopPrice : 0,
      leverage: mode === 'futures' ? leverage : 1,
      tpPrice: tpValue > 0 ? tpValue : null,
      slPrice: slValue > 0 ? slValue : null,
      triggerType,
      reduceOnly,
      postOnly,
      tif,
      cbRate: cbValue,
      marketPrice: markPrice || 0,
    }
  }

  const applyTpSlPct = (kind: 'tp' | 'sl' | 'both', k: number, usePrice: number) => {
    const base = usePrice > 0 ? usePrice : markPrice
    if (base <= 0) return
    const dir = isBuy ? 1 : -1
    const tp = base * (1 + dir * k / 100)
    const sl = base * (1 - dir * k / 100)
    if (kind === 'tp') setTpStr(tp.toFixed(2))
    if (kind === 'sl') setSlStr(sl.toFixed(2))
    if (kind === 'both') {
      setTpStr(tp.toFixed(2))
      setSlStr(sl.toFixed(2))
    }
  }

  const placeSpec = (spec: OrderDraftSpec): boolean => {
    const result = place(spec)
    if (result && !result.ok && 'error' in result) {
      setError(result.error)
      return false
    }
    setAmountStr('')
    if (result.ok && result.pending) {
      pushToast({ message: `${spec.symbol} — Askıya alındı`, tone: 'info' })
    } else {
      pushToast({ message: `${spec.symbol} — Emir gönderildi`, tone: 'success' })
    }
    return true
  }

  const submit = () => {
    setError(null)
    if (!draft && !cbStr && !(stopPrice > 0)) {
      setError('Geçerli bir tutar girin.')
      return
    }
    const spec = buildOrder()
    if ('k' in spec) {
      setError(
        spec.k === 'amount'
          ? 'Geçerli bir tutar girin.'
          : spec.k === 'price'
            ? 'Geçerli bir fiyat girin.'
            : 'Geçerli bir stop fiyatı girin.',
      )
      return
    }
    // A manually-entered price is never filled instantly. If the typed price is
    // already beyond the market (a marketable limit), convert it into a Stop
    // that triggers once the market actually reaches that value. Prices still
    // ahead of the market remain as waiting Limit orders.
    if (priceDirtyRef.current && spec.orderType === 'limit' && markPrice > 0) {
      const crossesNow = isBuy ? price > markPrice : price < markPrice
      if (crossesNow) {
        spec.orderType = 'stop-market'
        spec.stopPrice = price
        spec.entryPrice = markPrice
      }
    }
    if (confirmOrders) {
      setConfirmSpec(spec)
      return
    }
    if (placeSpec(spec)) onSubmitted?.()
  }

  const confirmAndSend = () => {
    const spec = confirmSpec
    setConfirmSpec(null)
    if (spec && placeSpec(spec)) onSubmitted?.()
  }

  const notional = draft ? draft.quantity * draft.entryPrice : 0
  const margin = mode === 'futures'
    ? (futuresSize?.margin ?? notional / (leverage || 1))
    : notional
  const levDisplay = mode === 'futures' ? `${leverage}x` : '1x'

  const submitLabel = mode === 'spot'
    ? isBuy ? 'Al (Buy)' : 'Sat (Sell)'
    : isBuy ? 'Buy / Long' : 'Sell / Short'

  const myPending = pendingOrders.filter(
    (o) => o.symbol === (ticker?.symbol ?? 'BTCUSDT') && !o.filled,
  )

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-exchange-border px-1">
        <button
          type="button"
          onClick={() => setSide(mode === 'spot' ? 'buy' : 'long')}
          className={cn(
            'min-w-0 flex-1 truncate whitespace-nowrap rounded px-3 py-1.5 text-center text-sm font-semibold transition-colors',
            isBuy
              ? 'bg-exchange-buy/10 text-exchange-buy'
              : 'text-exchange-muted hover:text-exchange-text',
          )}
        >
          {mode === 'spot' ? 'Al (Buy)' : 'Long'}
        </button>
        <button
          type="button"
          onClick={() => setSide(mode === 'spot' ? 'sell' : 'short')}
          className={cn(
            'min-w-0 flex-1 truncate whitespace-nowrap rounded px-3 py-1.5 text-center text-sm font-semibold transition-colors',
            isBuy
              ? 'text-exchange-muted hover:text-exchange-text'
              : 'bg-exchange-sell/10 text-exchange-sell',
          )}
        >
          {mode === 'spot' ? 'Sat (Sell)' : 'Short'}
        </button>
      </div>

      {mode === 'futures' && (
        <div className="border-b border-exchange-border px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-exchange-muted">Kaldıraç</span>
            <span className="font-semibold text-exchange-yellow">{leverage}x</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-exchange-muted">{MIN_LEVERAGE}x</span>
            <input
              type="range"
              min={MIN_LEVERAGE}
              max={MAX_LEVERAGE}
              step={1}
              value={leverage}
              aria-label="Leverage slider"
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-exchange-border accent-exchange-yellow"
            />
            <span className="text-xs text-exchange-muted">{MAX_LEVERAGE}x</span>
          </div>
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          <span className="min-w-0 flex-1 basis-24 truncate text-exchange-muted">
            {mode === 'spot' && side === 'sell' ? `Available (${coin})` : 'Kullanılabilir Bakiye'}
          </span>
          <span className={cn('shrink-0 whitespace-nowrap font-mono font-semibold', mode === 'spot' && side === 'sell' ? 'text-exchange-buy' : 'text-exchange-text')}>
            {mode === 'spot' && side === 'sell'
              ? `${formatPrice(heldCoin)} ${coin}`
              : `${formatNumber(balance, 2)} ${currency}`}
          </span>
        </div>

        <div>
          <label className="mb-1.5 block text-xs text-exchange-muted">Emir Tipi</label>
          <CustomSelect
            value={orderType}
            onChange={setOrderType}
            label="Order type"
            className="h-10 w-full cursor-pointer rounded border border-exchange-border bg-exchange-surface px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow"
            options={ORDER_TYPES.map((t) => ({ v: t, l: ORDER_TYPE_LABEL[t] }))}
          />
        </div>

        {showTrailingRate && (
          <div>
            <label className="mb-1.5 block text-xs text-exchange-muted">İzleme Oranı (%)</label>
            <input
              value={cbStr}
              onChange={(e) => setCbStr(e.target.value)}
              inputMode="decimal"
              placeholder="0.5"
              aria-label="Trailing callback rate"
              className="h-10 w-full rounded border border-exchange-border bg-exchange-surface px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow"
            />
          </div>
        )}

        {showStop && (
          <div>
            <label className="mb-1.5 block text-xs text-exchange-muted">Stop Fiyatı</label>
            <input
              value={stopStr}
              onChange={(e) => setStopStr(e.target.value)}
              inputMode="decimal"
              aria-label="Stop price"
              className="h-10 w-full rounded border border-exchange-border bg-exchange-surface px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow"
            />
          </div>
        )}

        {showPrice && (
          <div>
            <label className="mb-1.5 block text-xs text-exchange-muted">Fiyat</label>
            <div className="flex items-center">
              <input
                value={priceStr}
                onChange={(e) => {
                  const next = e.target.value
                  setPriceStr(next)
                  priceDirtyRef.current = next.trim() !== ''
                }}
                inputMode="decimal"
                aria-label="Order price"
                className="h-10 w-full min-w-0 rounded border border-exchange-border bg-exchange-surface px-3 pr-14 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow"
              />
              <span className="-ml-14 mr-3 shrink-0 text-xs text-exchange-muted">{currency}</span>
            </div>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs text-exchange-muted">Tutar ({currency})</label>
            <div className="flex flex-wrap items-center gap-1">
              {[25, 50, 75, 100].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setPct(k)}
                  className="rounded border border-exchange-border px-1.5 py-0.5 text-[11px] font-semibold text-exchange-muted transition-colors hover:border-exchange-yellow hover:text-exchange-yellow"
                >
                  {k}%
                </button>
              ))}
              <button
                onClick={() => setPct(100)}
                className="text-xs font-semibold text-exchange-yellow hover:underline"
                type="button"
              >
                Max
              </button>
            </div>
          </div>
          <div className="flex items-center">
            <input
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              inputMode="decimal"
              aria-label="Order amount"
              className="h-10 w-full min-w-0 rounded border border-exchange-border bg-exchange-surface px-3 pr-14 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow"
            />
            <span className="-ml-14 mr-3 shrink-0 text-xs text-exchange-muted">{currency}</span>
          </div>
        </div>

        <div className="rounded border border-exchange-border bg-exchange-card p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-exchange-muted">Tetik Tipi</span>
              <CustomSelect
                value={triggerType}
                onChange={setTriggerType}
                label="Trigger type"
                className="h-7 min-w-[8rem] cursor-pointer rounded border border-exchange-border bg-exchange-surface px-2 font-mono text-[11px] text-exchange-text outline-none focus:border-exchange-yellow"
                options={[
                  { v: 'last', l: 'Son Fiyat' },
                  { v: 'mark', l: 'Gösterge Fiyatı' },
                ]}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-2">
              <div className="min-w-0">
                <div className="mb-1 text-xs text-exchange-muted">Kar Al (TP)</div>
                <input
                  value={tpStr}
                  onChange={(e) => setTpStr(e.target.value)}
                  inputMode="decimal"
                  placeholder="—"
                  aria-label="Take profit price"
                  className="h-9 w-full min-w-0 rounded border border-exchange-buy/30 bg-exchange-surface px-2 font-mono text-sm text-exchange-buy outline-none focus:border-exchange-buy"
                />
                <div className="mt-1 flex flex-wrap gap-1">
                  {[5, 10, 20].map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => applyTpSlPct('tp', k, price)}
                      className="min-h-[1.75rem] rounded bg-exchange-surface px-1.5 text-[10px] font-semibold text-exchange-muted hover:text-exchange-buy"
                    >
                      %{k}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-0">
                <div className="mb-1 text-xs text-exchange-muted">Zarar Durdur (SL)</div>
                <input
                  value={slStr}
                  onChange={(e) => setSlStr(e.target.value)}
                  inputMode="decimal"
                  placeholder="—"
                  aria-label="Stop loss price"
                  className="h-9 w-full min-w-0 rounded border border-exchange-sell/30 bg-exchange-surface px-2 font-mono text-sm text-exchange-sell outline-none focus:border-exchange-sell"
                />
                <div className="mt-1 flex flex-wrap gap-1">
                  {[5, 10, 20].map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => applyTpSlPct('sl', k, price)}
                      className="min-h-[1.75rem] rounded bg-exchange-surface px-1.5 text-[10px] font-semibold text-exchange-muted hover:text-exchange-sell"
                    >
                      %{k}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs leading-5 text-exchange-muted">
            <input
              type="checkbox"
              checked={reduceOnly}
              onChange={(e) => setReduceOnly(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-exchange-yellow"
              disabled={mode === 'spot'}
            />
            <span>Sadece Azalt</span>
          </label>
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs leading-5 text-exchange-muted">
            <input
              type="checkbox"
              checked={postOnly}
              onChange={(e) => setPostOnly(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-exchange-yellow"
            />
            <span>Post-Only</span>
          </label>
          <label className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-exchange-muted">
            <span className="shrink-0">Geçerlilik</span>
            <CustomSelect
              value={tif}
              onChange={setTif}
              label="Time in force"
              className="h-7 min-w-[4.5rem] cursor-pointer rounded border border-exchange-border bg-exchange-surface px-2 font-mono text-xs text-exchange-text outline-none focus:border-exchange-yellow"
              options={(['GTC', 'IOC', 'FOK'] as TIF[]).map((t) => ({ v: t, l: t }))}
            />
          </label>
        </div>

        <div className="space-y-1.5 rounded bg-exchange-card px-3 py-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-exchange-muted">Qtty ({coin})</span>
            <span className="min-w-0 text-right font-mono text-exchange-text">
              {draft ? formatPrice(draft.quantity) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-exchange-muted">Notional</span>
            <span className="min-w-0 text-right font-mono text-exchange-text">
              {formatNumber(notional, 2)} {currency}
            </span>
          </div>
          {orderType !== 'market' && stopPrice > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-exchange-muted">Stop Fiyatı</span>
              <span className="min-w-0 text-right font-mono text-exchange-text">{formatPrice(stopPrice)}</span>
            </div>
          )}
          {(tpValue > 0 || slValue > 0) && (
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-exchange-muted">TP / SL</span>
              <span className="min-w-0 text-right font-mono text-exchange-text">
                {tpValue > 0 ? formatPrice(tpValue) : '—'} /{' '}
                {slValue > 0 ? formatPrice(slValue) : '—'}
              </span>
            </div>
          )}
          {mode === 'futures' && (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-exchange-muted">Margin / Lev</span>
                <span className="min-w-0 text-right font-mono text-exchange-text">
                  {formatNumber(margin, 2)} USDT · {levDisplay}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-exchange-muted">Max qty ({leverage}x)</span>
                <span className="min-w-0 text-right font-mono text-exchange-text">{formatPrice(maxValue)}</span>
              </div>
            </>
          )}
        </div>

        {myPending.length > 0 && (
          <div className="space-y-1 rounded bg-exchange-card px-3 py-2 text-xs">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-exchange-muted">
              Askıdaki Emirler
            </div>
            {myPending.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1 truncate">
                  <span
                    className={cn(
                      'font-mono font-semibold',
                      o.side === 'buy' || o.side === 'long' ? 'text-exchange-buy' : 'text-exchange-sell',
                    )}
                  >
                    {o.side === 'buy' || o.side === 'long' ? 'B' : 'S'}
                  </span>
                  <span className="ml-1 text-exchange-muted">
                    {o.orderType === 'oco'
                      ? 'OCO'
                      : o.orderType === 'trailing'
                        ? 'İzleyen Stop'
                        : o.orderType === 'stop-limit'
                          ? 'Stop-Limit'
                          : o.orderType === 'stop-market'
                            ? 'Stop-Market'
                            : 'Limit'}
                  </span>
                  <span className="ml-1 font-mono text-exchange-text">
                    {formatPrice(o.entryPrice || o.stopPrice || 0)}
                  </span>
                </div>
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
            ))}
          </div>
        )}

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded bg-exchange-sell/10 px-3 py-2 text-xs font-medium text-exchange-sell"
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <Button
          variant={isBuy ? 'buy' : 'sell'}
          size="lg"
          className="w-full text-base"
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </div>

      <AnimatePresence>
        {confirmSpec && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={{ duration: 0.14 }}
              className="w-full rounded-2xl border border-exchange-border bg-exchange-card p-5 shadow-2xl"
            >
              <h3 className="text-base font-bold text-exchange-text">Emri Onayla</h3>
              <p className="mt-0.5 text-xs text-exchange-muted">
                İşlem özeti — göndermeden önce kontrol edin.
              </p>

              <div className="mt-4 space-y-2 text-sm">
                <OrdersummariesRow
                  label="Yön"
                  value={
                    <span className={cn('font-bold uppercase', isBuy ? 'text-exchange-buy' : 'text-exchange-sell')}>
                      {submitLabel}
                    </span>
                  }
                />
                <OrdersummariesRow label="Çift" value={confirmSpec.symbol} />
                <OrdersummariesRow
                  label="Emir Tipi"
                  value={ORDER_TYPE_LABEL[confirmSpec.orderType]}
                />
                <OrdersummariesRow
                  label="Fiyat"
                  value={`${formatPrice(
                    confirmSpec.orderType === 'market' ? markPrice : confirmSpec.entryPrice,
                  )} USDT`}
                />
                {confirmSpec.stopPrice && confirmSpec.stopPrice > 0 && (
                  <OrdersummariesRow label="Stop Fiyatı" value={`${formatPrice(confirmSpec.stopPrice)} USDT`} />
                )}
                <OrdersummariesRow
                  label="Tutar"
                  value={`${formatNumber(
                    confirmSpec.quantity * (confirmSpec.orderType === 'market' ? markPrice : confirmSpec.entryPrice),
                    2,
                  )} USDT`}
                />
                <OrdersummariesRow
                  label="Miktar"
                  value={`${formatPrice(confirmSpec.quantity)} ${confirmSpec.symbol.replace('USDT', '')}`}
                />
                {(confirmSpec.tpPrice || confirmSpec.slPrice) && (
                  <OrdersummariesRow
                    label="TP / SL"
                    value={`${confirmSpec.tpPrice ? formatPrice(confirmSpec.tpPrice) : '—'} / ${
                      confirmSpec.slPrice ? formatPrice(confirmSpec.slPrice) : '—'
                    }`}
                  />
                )}
                {confirmSpec.reduceOnly && (
                  <OrdersummariesRow label="Mod" value="Sadece Azalt" />
                )}
                {confirmSpec.mode === 'futures' && (
                  <OrdersummariesRow label="Kaldıraç" value={`${confirmSpec.leverage}x`} />
                )}
              </div>

              <div className="mt-5 flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => setConfirmSpec(null)}>
                  Vazgeç
                </Button>
                <Button variant={isBuy ? 'buy' : 'sell'} className="flex-1" onClick={confirmAndSend}>
                  Onayla ve Gönder
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function OrdersummariesRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-exchange-surface px-3 py-2">
      <span className="shrink-0 text-exchange-muted">{label}</span>
      <span className="min-w-0 text-right font-mono font-medium break-words text-exchange-text">{value}</span>
    </div>
  )
}