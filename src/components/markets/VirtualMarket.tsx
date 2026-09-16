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
import { cn, formatCompact, formatNumber, formatPrice } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

/**
 * Sanal Piyasa (AMM x*y=k): iç ekosistem coinleri, arz-talebe göre fiyatlanır.
 * Liste + al/sat paneli; havuzlar Supabase'te (veya çevrimdışı yerel motorda).
 */
export function VirtualMarket() {
  const balance = useTradeStore((s) => s.balance)
  const pushToast = useToastStore((s) => s.push)
  const [coins, setCoins] = useState<VirtualCoin[]>([])
  const [holdings, setHoldings] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('ENTES')
  const [side, setSide] = useState<VirtualTradeSide>('buy')
  const [amountStr, setAmountStr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, held] = await Promise.all([listVirtualCoins(), getVirtualHoldings()])
      setCoins(list)
      setHoldings(held)
      if (list.length > 0 && !list.some((c) => c.symbol === selected)) {
        setSelected(list[0].symbol)
      }
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const coin = coins.find((c) => c.symbol === selected) ?? coins[0] ?? null
  const amount = parseFloat(amountStr)
  const holding = coin ? (holdings[coin.symbol] ?? 0) : 0

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
    if (!coin || busy) return
    if (!Number.isFinite(amount) || amount <= 0) {
      pushToast({ message: 'Geçerli bir tutar gir.', tone: 'error' })
      return
    }
    setBusy(true)
    try {
      const res = await executeVirtualTrade(coin.symbol, side, amount)
      setAmountStr('')
      await load()
      pushToast({
        message:
          side === 'buy'
            ? `${formatNumber(res.tokenAmount, 6)} ${coin.symbol} alındı.`
            : `${formatNumber(res.usdtAmount, 2)} USDT alındı.`,
        tone: 'success',
      })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'İşlem yapılamadı.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[24rem] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-exchange-surface">
            <tr className="border-b border-exchange-border text-xs uppercase text-exchange-muted">
              <th className="px-3 py-2.5 text-left font-semibold sm:px-4">Coin</th>
              <th className="px-3 py-2.5 text-right font-semibold sm:px-4">Fiyat (USDT)</th>
              <th className="hidden px-4 py-2.5 text-right font-semibold sm:table-cell">Havuz</th>
              <th className="px-3 py-2.5 text-right font-semibold sm:px-4">Hacim 24s</th>
            </tr>
          </thead>
          <tbody>
            {loading && coins.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className="px-4 py-16 text-center text-sm text-exchange-muted">
                    Sanal piyasa yükleniyor…
                  </div>
                </td>
              </tr>
            ) : (
              coins.map((c) => (
                <tr
                  key={c.symbol}
                  onClick={() => setSelected(c.symbol)}
                  className={cn(
                    'cursor-pointer border-b border-exchange-border/50 transition-colors last:border-0 hover:bg-exchange-surface',
                    coin?.symbol === c.symbol && 'bg-exchange-yellow/5',
                  )}
                >
                  <td className="px-3 py-2.5 sm:px-4">
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold text-exchange-text">{c.symbol}</span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                          c.type === 'commodity'
                            ? 'bg-exchange-yellow/15 text-exchange-yellow'
                            : 'bg-exchange-buy/10 text-exchange-buy',
                        )}
                      >
                        {c.type === 'commodity' ? 'Emtia' : 'Kripto'}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-exchange-muted">{c.name}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono font-semibold text-exchange-text sm:px-4">
                    {formatPrice(c.price)}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-2.5 text-right font-mono text-exchange-muted sm:table-cell">
                    {formatCompact(c.reserveUsdt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-exchange-muted sm:px-4">
                    {formatCompact(c.volume24h)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {coin && (
        <div className="border-t border-exchange-border px-3 py-3 sm:px-4">
          <div className="rounded-2xl border border-exchange-border bg-exchange-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold text-exchange-text">
                  {coin.symbol} <span className="font-normal text-exchange-muted">/ USDT</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-exchange-muted">
                  <span>
                    Fiyat <span className="text-exchange-text">{formatPrice(coin.price)}</span>
                  </span>
                  <span>
                    Elinde{' '}
                    <span className="text-exchange-text">{formatNumber(holding, 6)}</span>
                  </span>
                  <span>
                    Bakiye <span className="text-exchange-text">{formatNumber(balance, 2)}</span>
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 overflow-hidden rounded-lg border border-exchange-border">
                {(['buy', 'sell'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={side === s}
                    onClick={() => setSide(s)}
                    className={cn(
                      'min-h-[2rem] whitespace-nowrap px-3 text-xs font-bold transition-colors active:scale-95',
                      side === s
                        ? s === 'buy'
                          ? 'bg-exchange-buy/15 text-exchange-buy'
                          : 'bg-exchange-sell/15 text-exchange-sell'
                        : 'text-exchange-muted hover:text-exchange-text',
                    )}
                  >
                    {s === 'buy' ? 'Al' : 'Sat'}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                inputMode="decimal"
                placeholder={side === 'buy' ? 'USDT tutarı (örn. 10)' : `${coin.symbol} adedi`}
                aria-label={side === 'buy' ? 'Alış tutarı (USDT)' : 'Satış adedi'}
                className="h-11 w-full min-w-0 flex-1 rounded-xl border border-exchange-border bg-exchange-bg px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/60"
              />
              <Button
                variant={side === 'buy' ? 'buy' : 'sell'}
                onClick={() => void submit()}
                disabled={busy || !quote}
                className="whitespace-nowrap"
              >
                {busy ? 'İşleniyor…' : side === 'buy' ? `${coin.symbol} Al` : `${coin.symbol} Sat`}
              </Button>
            </div>

            <div className="mt-2 min-h-5 font-mono text-[11px] text-exchange-muted" aria-live="polite">
              {quote ? (
                <>
                  Alacağın:{' '}
                  <span className="font-bold text-exchange-text">
                    {side === 'buy'
                      ? `${formatNumber(quote.tokenAmount, 6)} ${coin.symbol}`
                      : `${formatNumber(quote.usdtAmount, 2)} USDT`}
                  </span>{' '}
                  · Etki %{formatNumber(quote.priceImpactPct, 2)} · %0.3 havuz ücreti dahil
                </>
              ) : (
                amountStr ? 'Tutar havuz için geçersiz.' : 'Tutar girince önizleme çıkar.'
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
