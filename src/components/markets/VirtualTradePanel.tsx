import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTradeStore } from '@/store/tradeStore'
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
import { Button } from '@/components/ui/Button'

/**
 * Sanal coin al/sat paneli (AMM): Al-Sat ekranında sanal sembol
 * seçiliyken standart panel yerine gösterilir.
 * Gerçek coin paneliyle birebir aynı başlık/düzen davranışı:
 * mobil Al/Sat butonundan gelen `initialSide` açılış yönünü belirler
 * (Al'da Al, Sat'ta Sat açılır); içeriden yine切换 edilebilir.
 */
export function VirtualTradePanel({
  symbol,
  initialSide,
  onSubmitted,
}: {
  symbol: string
  initialSide?: 'buy' | 'sell'
  onSubmitted?: () => void
}) {
  const balance = useTradeStore((s) => s.balance)
  const pushToast = useToastStore((s) => s.push)
  const [coin, setCoin] = useState<VirtualCoin | null>(null)
  const [holding, setHolding] = useState(0)
  const [side, setSide] = useState<VirtualTradeSide>(initialSide ?? 'buy')
  const [amountStr, setAmountStr] = useState('')
  const [busy, setBusy] = useState(false)

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
    setSide(initialSide ?? 'buy')
    void load()
  }, [load, initialSide])

  const amount = parseFloat(amountStr)

  const quote = useMemo(() => {
    if (!coin || !Number.isFinite(amount) || amount <= 0) return null
    try {
      const pool = { symbol: coin.symbol, reserveUsdt: coin.reserveUsdt, reserveToken: coin.reserveToken }
      return side === 'buy' ? quoteVirtualBuy(pool, amount) : quoteVirtualSell(pool, amount)
    } catch {
      return null
    }
  }, [coin, side, amount])

  const submit = async () => {
    if (busy) return
    if (!Number.isFinite(amount) || amount <= 0) {
      pushToast({ message: 'Geçerli bir tutar gir.', tone: 'error' })
      return
    }
    setBusy(true)
    try {
      const res = await executeVirtualTrade(symbol, side, amount)
      // Ortalama maliyeti güncelle (cüzdan + panel aynı kaynaktan okur).
      try {
        useTradeStore.getState().recordVirtualTrade(
          symbol,
          side,
          side === 'buy' ? res.tokenAmount : amount,
          side === 'buy' ? amount : res.usdtAmount,
          holding,
        )
      } catch {
        // best effort — işlem zaten gerçekleşti
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
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'İşlem yapılamadı.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-exchange-border px-1">
        {(['buy', 'sell'] as const).map((s) => {
          const active = side === s
          const isBuy = s === 'buy'
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={cn(
                'min-w-0 flex-1 truncate whitespace-nowrap rounded px-3 py-1.5 text-center text-sm font-semibold transition-colors',
                active
                  ? isBuy
                    ? 'bg-exchange-buy/10 text-exchange-buy'
                    : 'bg-exchange-sell/10 text-exchange-sell'
                  : 'text-exchange-muted hover:text-exchange-text',
              )}
            >
              {isBuy ? 'Al (Buy)' : 'Sat (Sell)'}
            </button>
          )
        })}
      </div>

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
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 md:mb-1.5">
            <label className="text-xs text-exchange-muted">
              {side === 'buy' ? 'Tutar (USDT)' : `Tutar (${symbol})`}
            </label>
            {coin && (
              <span className="font-mono text-[11px] text-exchange-muted">
                1 {symbol} ≈ {formatPrice(coin.price)} USDT
              </span>
            )}
          </div>
          <input
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            inputMode="decimal"
            aria-label={side === 'buy' ? 'Alış tutarı (USDT)' : 'Satış adedi'}
            className="h-9 w-full min-w-0 rounded border border-exchange-border bg-exchange-surface px-2.5 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow md:h-10 md:px-3"
          />
        </div>

        <div className="space-y-1.5 rounded bg-exchange-card px-3 py-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-exchange-muted">Alacağın</span>
            <span className="min-w-0 text-right font-mono font-bold text-exchange-text">
              {quote
                ? side === 'buy'
                  ? `${formatNumber(quote.tokenAmount, 6)} ${symbol}`
                  : `${formatNumber(quote.usdtAmount, 2)} USDT`
                : '—'}
            </span>
          </div>
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

        <Button
          variant={side === 'buy' ? 'buy' : 'sell'}
          size="lg"
          className="w-full text-base"
          onClick={() => void submit()}
          disabled={busy || !quote}
        >
          {busy ? 'İşleniyor…' : side === 'buy' ? `${symbol} Al` : `${symbol} Sat`}
        </Button>
      </div>
    </div>
  )
}
