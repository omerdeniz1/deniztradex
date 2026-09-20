import { useState } from 'react'
import { useDnzStore } from '@/store/dnzStore'
import { useDnzTrade } from '@/hooks/useDnzTrade'
import { cn, formatNumber, formatPrice } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

interface Props {
  initialSide?: 'buy' | 'sell'
  onSubmitted?: () => void
  /** Mobil sheet gibi tek-yön kullanımlarda sekmeleri gizler. */
  lockedSide?: boolean
}

/**
 * DNZ işlem paneli (işlem ekranı): USDT ↔ DNZ takası, DNZ bakiyesi ve
 * simüle fiyat. Sanal AMM paneliyle aynı kullanım sözleşmesi
 * (`initialSide` / `onSubmitted` / `lockedSide`).
 */
export function DnzTradePanel({ initialSide, onSubmitted, lockedSide = false }: Props) {
  const dnzBalance = useDnzStore((s) => s.balance)
  const dnzPrice = useDnzStore((s) => s.price)
  const { buyForUsdt, sellQty } = useDnzTrade()
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide ?? 'buy')
  const [amountStr, setAmountStr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const amount = parseFloat(amountStr.replace(',', '.'))
  const previewQty = side === 'buy' && Number.isFinite(amount) && amount > 0 && dnzPrice > 0 ? amount / dnzPrice : 0
  const previewUsdt = side === 'sell' && Number.isFinite(amount) && amount > 0 ? amount * dnzPrice : 0

  const submit = () => {
    if (busy) return
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const res = side === 'buy' ? buyForUsdt(amount) : sellQty(amount)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setAmountStr('')
      setNotice(res.message)
      onSubmitted?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4">
      <div className="rounded-xl border border-exchange-border/60 bg-exchange-bg/60 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-exchange-muted">DNZ Bakiyen</span>
          <span className="rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-bold text-exchange-yellow">
            Borsa Tokenı
          </span>
        </div>
        <div className="mt-1 font-mono text-xl font-bold text-exchange-text">
          {formatNumber(dnzBalance, 4)} <span className="text-sm text-exchange-yellow">DNZ</span>
        </div>
        <div className="mt-0.5 text-xs text-exchange-muted">
          ≈ {formatNumber(dnzBalance * dnzPrice, 2)} USDT · Fiyat (simüle): {formatPrice(dnzPrice)} USDT
        </div>
      </div>

      {!lockedSide && (
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-exchange-border/60 p-1">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s)
                setError(null)
                setNotice(null)
              }}
              className={cn(
                'h-9 rounded-lg text-sm font-bold transition-colors',
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
      )}

      <div>
        <label htmlFor="dnz-panel-amount" className="mb-1 block text-xs font-semibold text-exchange-muted">
          {side === 'buy' ? (
            <>USDT tutarı {previewQty > 0 && <span className="text-exchange-text">≈ {formatNumber(previewQty, 4)} DNZ</span>}</>
          ) : (
            <>DNZ miktarı {previewUsdt > 0 && <span className="text-exchange-text">≈ {formatNumber(previewUsdt, 2)} USDT</span>}</>
          )}
        </label>
        <input
          id="dnz-panel-amount"
          value={amountStr}
          onChange={(e) => {
            setAmountStr(e.target.value)
            setError(null)
            setNotice(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          inputMode="decimal"
          placeholder={side === 'buy' ? 'USDT tutarı' : 'DNZ miktarı'}
          disabled={busy}
          className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50"
        />
      </div>

      {error && <p className="text-xs font-medium text-exchange-sell">{error}</p>}
      {notice && <p className="text-xs font-medium text-exchange-buy">{notice}</p>}

      <Button
        variant={side === 'buy' ? 'buy' : 'sell'}
        onClick={submit}
        disabled={busy || !(amount > 0)}
        className="w-full"
      >
        {busy ? 'İşleniyor…' : side === 'buy' ? 'DNZ Al' : 'DNZ Sat'}
      </Button>
      <p className="text-[11px] leading-relaxed text-exchange-muted">
        DNZ takasında komisyon yoktur. Komisyon indirimi için cüzdandaki DNZ bölümünden tercihi açabilirsin.
      </p>
    </div>
  )
}
