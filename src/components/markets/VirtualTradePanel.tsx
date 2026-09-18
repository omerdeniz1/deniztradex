import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTradeStore } from '@/store/tradeStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useToastStore } from '@/store/toastStore'
import { quoteVirtualBuy, quoteVirtualSell } from '@/engine/virtualAmm'
import {
  executeVirtualTrade,
  getVirtualHoldings,
  listVirtualCoins,
  type VirtualCoin,
  type VirtualTradeSide,
} from '@/services/virtualMarketService'
import { cn, formatNumber, formatPrice } from '@/lib/utils'
import type { OrderType, TIF } from '@/types'
import { Button } from '@/components/ui/Button'
import { CustomSelect } from '@/components/ui/CustomSelect'

/**
 * Sanal coin al/sat paneli (AMM) — gerçek coin paneliyle BİREBİR aynı
 * arayüz: Emir Tipi (Piyasa/Limit), Fiyat, %25–Max hızlı tutar, TP/SL
 * akordeonu, Sadece Azalt / Post-Only / Geçerlilik, özet kutusu,
 * askıdaki emirler ve (ayarlıysa) onay penceresi.
 *
 * Davranış eşlemesi:
 *  - Piyasa + kesen Limit → havuzda ANINDA gerçekleşir
 *    (`executeVirtualTrade` RPC / yerel AMM).
 *  - Kesmeyen Limit → bekleyen emre park eder; havuz fiyatı hedefe
 *    değince watchdog işletir (gerçek paneldeki askıdaki emirle aynı).
 *  - Alışa bağlı TP/SL → lot oto-satıma yazılır, hedefte havuzda satılır.
 *  - Alt bilgi şeridi AMM'ye özeldir: elindeki miktar, fiyat etkisi,
 *    havuz ücreti (%0.3) — tasarımı bozmadan özet kutusunda durur.
 */

type VirtualOrderType = Extract<OrderType, 'market' | 'limit'>

const ORDER_TYPES: VirtualOrderType[] = ['market', 'limit']

const ORDER_TYPE_LABEL: Record<VirtualOrderType, string> = {
  market: 'Piyasa',
  limit: 'Limit',
}

export function VirtualTradePanel({
  symbol,
  marketPrice,
  initialSide,
  onSubmitted,
  lockedSide = false,
  showTriggerType = true,
}: {
  symbol: string
  /** Canlı havuz fiyatı (soket/ticker; yoksa havuz fiyatı kullanılır). */
  marketPrice?: number
  initialSide?: 'buy' | 'sell'
  onSubmitted?: () => void
  /**
   * Tek-yön kilidi (mobil Al/Sat menüsü): açıkken üstteki Al/Sat
   * sekmeleri gizlenir, panel yalnızca `initialSide` yönünde işlem
   * yapar — gerçek coin paneliyle birebir aynı davranış.
   */
  lockedSide?: boolean
  /** Ayrıntı satırını gizler (mobil sheet sade görünüm). Varsayılan açık. */
  showTriggerType?: boolean
}) {
  const balance = useTradeStore((s) => s.balance)
  const confirmOrders = useSettingsStore((s) => s.confirmOrders)
  const virtualPending = useTradeStore((s) => s.virtualPending)
  const pushToast = useToastStore((s) => s.push)

  const [coin, setCoin] = useState<VirtualCoin | null>(null)
  const [holding, setHolding] = useState(0)
  const [side, setSide] = useState<VirtualTradeSide>(initialSide ?? 'buy')
  const [orderType, setOrderType] = useState<VirtualOrderType>('market')
  const [priceStr, setPriceStr] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [tpStr, setTpStr] = useState('')
  const [slStr, setSlStr] = useState('')
  const [postOnly, setPostOnly] = useState(false)
  const [tif, setTif] = useState<TIF>('GTC')
  const [tpSlOpen, setTpSlOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const priceDirtyRef = useRef(false)
  const priceSymbolRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, held] = await Promise.all([listVirtualCoins(), getVirtualHoldings()])
      setCoin(list.find((c) => c.symbol === symbol) ?? null)
      setHolding(held[symbol] ?? 0)
    } catch {
      // sessiz — panel yine de formu gösterir
    }
  }, [symbol])

  useEffect(() => {
    setAmountStr('')
    setPriceStr('')
    priceDirtyRef.current = false
    priceSymbolRef.current = null
    setSide(initialSide ?? 'buy')
    void load()
  }, [load, initialSide])

  const poolPrice = coin?.price ?? 0
  const mark = marketPrice && marketPrice > 0 ? marketPrice : poolPrice
  const isBuy = side === 'buy'

  // Fiyat kutusu: kullanıcı yazana dek canlı fiyatı izler (gerçek
  // panelle aynı). Temizlenince veya coin değişince izlemeye döner.
  useEffect(() => {
    if (orderType !== 'limit') return
    if (!(mark > 0)) return
    if (priceSymbolRef.current !== symbol) {
      priceSymbolRef.current = symbol
      priceDirtyRef.current = false
      setPriceStr(String(mark))
    } else if (!priceDirtyRef.current) {
      setPriceStr(String(mark))
    }
  }, [mark, symbol, orderType])

  const price = parseFloat(priceStr)
  const amount = parseFloat(amountStr)
  const tpValue = parseFloat(tpStr)
  const slValue = parseFloat(slStr)

  const showPrice = orderType === 'limit'
  // Piyasayı kesen limit: ALIŞTA limit >= piyasa, SATIŞTA limit <= piyasa.
  const marketable =
    orderType === 'market' ||
    (Number.isFinite(price) && price > 0 && mark > 0 && (isBuy ? price >= mark : price <= mark))

  const quote = useMemo(() => {
    if (!coin || !Number.isFinite(amount) || amount <= 0) return null
    try {
      const pool = { symbol: coin.symbol, reserveUsdt: coin.reserveUsdt, reserveToken: coin.reserveToken }
      return isBuy ? quoteVirtualBuy(pool, amount) : quoteVirtualSell(pool, amount)
    } catch {
      return null
    }
  }, [coin, isBuy, amount])

  const setPct = useCallback(
    (k: number) => {
      const base = isBuy ? balance : holding
      if (!(base > 0)) return
      const v = (base * k) / 100
      setAmountStr(v > 0 ? String(Math.round(v * 100) / 100) : '')
    },
    [balance, holding, isBuy],
  )

  const applyTpSlPct = (kind: 'tp' | 'sl', k: number) => {
    const base = Number.isFinite(price) && price > 0 ? price : mark
    if (!(base > 0)) return
    const dir = isBuy ? 1 : -1
    if (kind === 'tp') setTpStr((base * (1 + (dir * k) / 100)).toFixed(4))
    else setSlStr((base * (1 - (dir * k) / 100)).toFixed(4))
  }

  const myPending = virtualPending.filter((o) => o.symbol === symbol)

  const validate = (): string | null => {
    if (!Number.isFinite(amount) || amount <= 0) return 'Geçerli bir tutar girin.'
    if (orderType === 'limit' && (!Number.isFinite(price) || price <= 0)) {
      return 'Geçerli bir fiyat girin.'
    }
    if (postOnly && marketable && orderType !== 'market') {
      return 'Post-Only: emir anında gerçekleşir.'
    }
    if (postOnly && orderType === 'market') {
      return 'Piyasa emri Post-Only ile kullanılamaz.'
    }
    if (!isBuy && amount > holding) return 'Yetersiz coin bakiyesi.'
    if (isBuy && orderType === 'market' && amount > balance) return 'Yetersiz USDT bakiyesi.'
    if (tif === 'FOK') {
      if (isBuy ? amount > balance : amount > holding) {
        return 'FOK: tam miktar karşılanamıyor.'
      }
      if (orderType === 'limit' && !marketable) {
        return 'Emir anında karşılanabilir değil.'
      }
    }
    if (tif === 'IOC' && orderType === 'limit' && !marketable) {
      return 'Emir anında karşılanabilir değil.'
    }
    return null
  }

  /** IOC kırpması: karşılanabilir azami miktar (piyasa emirlerinde). */
  const cappedAmount = (): number => {
    if (tif !== 'IOC' || orderType !== 'market') return amount
    const cap = isBuy ? balance : holding
    return Math.min(amount, Math.max(0, cap))
  }

  const fireNow = async (execAmount: number) => {
    const res = await executeVirtualTrade(symbol, side, execAmount)
    try {
      useTradeStore.getState().recordVirtualTrade(
        symbol,
        side,
        side === 'buy' ? res.tokenAmount : execAmount,
        side === 'buy' ? execAmount : res.usdtAmount,
        holding,
      )
    } catch {
      // best effort — işlem zaten gerçekleşti
    }
    // Alışa bağlı TP/SL → lot oto-satıma yazılır.
    if (isBuy && (tpValue > 0 || slValue > 0)) {
      useTradeStore.getState().addVirtualTpSl({
        symbol,
        quantity: res.tokenAmount,
        tpPrice: tpValue > 0 ? tpValue : null,
        slPrice: slValue > 0 ? slValue : null,
      })
    }
    setAmountStr('')
    await load()
    pushToast({
      message:
        side === 'buy'
          ? `${formatNumber(res.tokenAmount, 6)} ${symbol} alındı.`
          : `${formatNumber(res.usdtAmount, 2)} USDT alındı.`,
      tone: 'success',
    })
    onSubmitted?.()
  }

  const parkPending = () => {
    useTradeStore.getState().placeVirtualPending({
      symbol,
      side,
      amount,
      limitPrice: price,
      tpPrice: tpValue > 0 ? tpValue : null,
      slPrice: slValue > 0 ? slValue : null,
    })
    setAmountStr('')
    pushToast({ message: `${symbol} — Askıya alındı`, tone: 'info' })
    onSubmitted?.()
  }

  const submit = async () => {
    if (busy) return
    setError(null)
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    if (!marketable) {
      if (confirmOrders) {
        setConfirmOpen(true)
        return
      }
      parkPending()
      return
    }
    const execAmount = cappedAmount()
    if (!(execAmount > 0)) {
      setError('IOC: karşılanacak miktar yok.')
      return
    }
    if (confirmOrders) {
      setConfirmOpen(true)
      return
    }
    setBusy(true)
    try {
      await fireNow(execAmount)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'İşlem yapılamadı.')
    } finally {
      setBusy(false)
    }
  }

  const confirmAndSend = async () => {
    setConfirmOpen(false)
    if (busy) return
    if (!marketable) {
      parkPending()
      return
    }
    const execAmount = cappedAmount()
    if (!(execAmount > 0)) {
      setError('IOC: karşılanacak miktar yok.')
      return
    }
    setBusy(true)
    try {
      await fireNow(execAmount)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'İşlem yapılamadı.')
    } finally {
      setBusy(false)
    }
  }

  const submitLabel = isBuy ? `${symbol} Al` : `${symbol} Sat`

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {lockedSide ? (
        <div
          aria-live="polite"
          className={cn(
            'flex h-11 shrink-0 items-center justify-center border-b border-exchange-border px-3 text-sm font-extrabold uppercase tracking-wide',
            isBuy ? 'text-exchange-buy' : 'text-exchange-sell',
          )}
        >
          {isBuy ? 'Alış Emri' : 'Satış Emri'}
        </div>
      ) : (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-exchange-border px-1">
          {(['buy', 'sell'] as const).map((s) => {
            const active = side === s
            const tabBuy = s === 'buy'
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={cn(
                  'min-w-0 flex-1 truncate whitespace-nowrap rounded px-3 py-1.5 text-center text-sm font-semibold transition-colors',
                  active
                    ? tabBuy
                      ? 'bg-exchange-buy/10 text-exchange-buy'
                      : 'bg-exchange-sell/10 text-exchange-sell'
                    : 'text-exchange-muted hover:text-exchange-text',
                )}
              >
                {tabBuy ? 'Al (Buy)' : 'Sat (Sell)'}
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-2.5 py-3 md:space-y-4 md:px-4 md:py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          <span className="min-w-0 flex-1 basis-24 truncate text-exchange-muted">
            Kullanılabilir Bakiye
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono font-semibold text-exchange-text">
            {formatNumber(balance, 2)} USDT
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          <span className="min-w-0 flex-1 basis-24 truncate text-exchange-muted">
            Elindeki {symbol}
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono font-semibold text-exchange-text">
            {formatNumber(holding, 6)}
          </span>
        </div>

        <div>
          <label className="mb-1 block text-xs text-exchange-muted md:mb-1.5">Emir Tipi</label>
          <CustomSelect
            value={orderType}
            onChange={setOrderType}
            label="Order type"
            className="h-9 w-full cursor-pointer rounded border border-exchange-border bg-exchange-surface px-2.5 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow md:h-10 md:px-3"
            options={ORDER_TYPES.map((t) => ({ v: t, l: ORDER_TYPE_LABEL[t] }))}
          />
        </div>

        {showPrice && (
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 md:mb-1.5">
              <label className="text-xs text-exchange-muted">Fiyat</label>
              {mark > 0 && (
                <span className="font-mono text-[11px] text-exchange-muted">
                  1 {symbol} ≈ {formatPrice(mark)} USDT
                </span>
              )}
            </div>
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
                className="h-9 w-full min-w-0 rounded border border-exchange-border bg-exchange-surface px-2.5 pr-14 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow md:h-10 md:px-3"
              />
              <span className="-ml-14 mr-3 shrink-0 text-xs text-exchange-muted">USDT</span>
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 md:mb-1.5">
            <label className="text-xs text-exchange-muted">
              {isBuy ? 'Tutar (USDT)' : `Tutar (${symbol})`}
            </label>
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
              className="h-9 w-full min-w-0 rounded border border-exchange-border bg-exchange-surface px-2.5 pr-14 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow md:h-10 md:px-3"
            />
            <span className="-ml-14 mr-3 shrink-0 text-xs text-exchange-muted">
              {isBuy ? 'USDT' : symbol}
            </span>
          </div>
        </div>

        <div className="rounded border border-exchange-border bg-exchange-card">
          {showTriggerType && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pt-2.5 md:px-3 md:pt-3">
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-exchange-muted">
                Gerçekleşme
              </span>
              <span className="font-mono text-[11px] font-bold text-exchange-text">
                {orderType === 'market' ? 'Anında (havuz)' : marketable ? 'Anında (kesen limit)' : 'Hedefte (askıda)'}
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setTpSlOpen((v) => !v)}
            aria-expanded={tpSlOpen}
            aria-controls="vtpsl-body"
            className="flex w-full items-center gap-2 px-2.5 py-2.5 text-left transition-colors active:scale-[0.99] md:px-3"
          >
            <span
              aria-hidden
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-extrabold transition-colors',
                tpSlOpen
                  ? 'border-exchange-yellow bg-exchange-yellow text-black'
                  : 'border-exchange-border text-transparent',
              )}
            >
              ✓
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-bold text-exchange-text">
              TP/SL
              <span className="ml-1.5 font-normal text-exchange-muted">Kar Al / Zarar Durdur</span>
            </span>
            {(tpValue > 0 || slValue > 0) && (
              <span className="shrink-0 rounded-full bg-exchange-yellow/15 px-2 py-0.5 font-mono text-[10px] font-bold text-exchange-yellow">
                ayarlı
              </span>
            )}
            <span
              aria-hidden
              className={cn('shrink-0 text-[10px] text-exchange-muted transition-transform', tpSlOpen && 'rotate-180')}
            >
              ▼
            </span>
          </button>
          <AnimatePresence initial={false}>
            {tpSlOpen && (
              <motion.div
                id="vtpsl-body"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 gap-2.5 px-2.5 pb-2.5 sm:grid-cols-2 sm:gap-2 md:px-3 md:pb-3">
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
                          onClick={() => applyTpSlPct('tp', k)}
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
                          onClick={() => applyTpSlPct('sl', k)}
                          className="min-h-[1.75rem] rounded bg-exchange-surface px-1.5 text-[10px] font-semibold text-exchange-muted hover:text-exchange-sell"
                        >
                          %{k}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <label
            className="flex min-w-0 cursor-pointer items-center gap-2 text-xs leading-5 text-exchange-muted"
            title="Sanal spot işlemde yalnızca azaltma olur — her satış eldekinin içinden yapılır"
          >
            <input
              type="checkbox"
              checked={false}
              disabled
              aria-label="Sadece Azalt (sanal spotta her satış zaten azaltmadır)"
              className="h-4 w-4 shrink-0 accent-exchange-yellow disabled:opacity-40"
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
            <span className="shrink-0 text-exchange-muted">Alacağın (tahmini)</span>
            <span className="min-w-0 text-right font-mono font-bold text-exchange-text">
              {quote
                ? isBuy
                  ? `${formatNumber(quote.tokenAmount, 6)} ${symbol}`
                  : `${formatNumber(quote.usdtAmount, 2)} USDT`
                : '—'}
            </span>
          </div>
          {orderType === 'limit' && Number.isFinite(price) && price > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-exchange-muted">Limit fiyat</span>
              <span className="min-w-0 text-right font-mono text-exchange-text">{formatPrice(price)} USDT</span>
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
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-exchange-muted">Fiyat etkisi</span>
            <span className="min-w-0 text-right font-mono text-exchange-text">
              {quote ? `%${formatNumber(quote.priceImpactPct, 2)}` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-exchange-muted">Havuz ücreti</span>
            <span className="min-w-0 text-right font-mono text-exchange-muted">%0.3</span>
          </div>
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
                      o.side === 'buy' ? 'text-exchange-buy' : 'text-exchange-sell',
                    )}
                  >
                    {o.side === 'buy' ? 'B' : 'S'}
                  </span>
                  <span className="ml-1 text-exchange-muted">Limit</span>
                  <span className="ml-1 font-mono text-exchange-text">
                    {formatPrice(o.limitPrice)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    useTradeStore.getState().cancelVirtualPending(o.id)
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
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? 'İşleniyor…' : submitLabel}
        </Button>
      </div>

      <AnimatePresence>
        {confirmOpen && (
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
                <ConfirmRow
                  label="Yön"
                  value={
                    <span className={cn('font-bold uppercase', isBuy ? 'text-exchange-buy' : 'text-exchange-sell')}>
                      {submitLabel}
                    </span>
                  }
                />
                <ConfirmRow label="Emir Tipi" value={ORDER_TYPE_LABEL[orderType]} />
                {orderType === 'limit' && Number.isFinite(price) && price > 0 && (
                  <ConfirmRow label="Limit Fiyat" value={`${formatPrice(price)} USDT`} />
                )}
                <ConfirmRow
                  label="Tutar"
                  value={`${formatNumber(amount || 0, 2)} ${isBuy ? 'USDT' : symbol}`}
                />
                {quote && (
                  <ConfirmRow
                    label="Tahmini Alacağın"
                    value={
                      isBuy
                        ? `${formatNumber(quote.tokenAmount, 6)} ${symbol}`
                        : `${formatNumber(quote.usdtAmount, 2)} USDT`
                    }
                  />
                )}
                {(tpValue > 0 || slValue > 0) && (
                  <ConfirmRow
                    label="TP / SL"
                    value={`${tpValue > 0 ? formatPrice(tpValue) : '—'} / ${
                      slValue > 0 ? formatPrice(slValue) : '—'
                    }`}
                  />
                )}
                <ConfirmRow
                  label="Gerçekleşme"
                  value={marketable ? 'Anında (havuz)' : 'Hedefte (askıda)'}
                />
              </div>
              <div className="mt-5 flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => setConfirmOpen(false)}>
                  Vazgeç
                </Button>
                <Button variant={isBuy ? 'buy' : 'sell'} className="flex-1" onClick={() => void confirmAndSend()}>
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

function ConfirmRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-exchange-surface px-3 py-2">
      <span className="shrink-0 text-exchange-muted">{label}</span>
      <span className="min-w-0 text-right font-mono font-medium break-words text-exchange-text">{value}</span>
    </div>
  )
}
