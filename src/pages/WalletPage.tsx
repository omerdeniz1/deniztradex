import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import confetti from 'canvas-confetti'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore } from '@/store/dnzStore'
import { useDnzTrade } from '@/hooks/useDnzTrade'
import { useToastStore } from '@/store/toastStore'
import { useUiStore } from '@/store/uiStore'
import { useUnifiedTickers } from '@/hooks/useUnifiedTickers'
import { getSessionUserId } from '@/services/authService'
import { syncDepositToSupabase } from '@/services/supabaseWallet'
import { DNZ_TOTAL_SUPPLY } from '@/services/dnzService'
import { getVirtualHoldings } from '@/services/virtualMarketService'
import { formatNumber, formatPrice } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'

export function WalletPage() {
  const balance = useTradeStore((s) => s.balance)
  const deposits = useTradeStore((s) => s.deposits)
  const withdrawals = useTradeStore((s) => s.withdrawals)
  const redeemedPromos = useTradeStore((s) => s.promos)
  const spotBalances = useTradeStore((s) => s.spotBalances)
  const spotAvgCosts = useTradeStore((s) => s.spotAvgCosts)
  const virtualAvgCosts = useTradeStore((s) => s.virtualAvgCosts)
  const redeemPromoAsync = useTradeStore((s) => s.redeemPromoAsync)
  const openDeposit = useUiStore((s) => s.openDeposit)
  const openWithdraw = useUiStore((s) => s.openWithdraw)

  // Birleşik tickers: gerçek (BTCUSDT) + sanal (ENTES) fiyatlar tek map'te.
  const { tickers } = useUnifiedTickers()

  const [code, setCode] = useState('')
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  )
  const [virtualHoldings, setVirtualHoldings] = useState<Record<string, number>>({})

  const priceOf = useCallback(
    (coin: string): number => {
      if (coin === 'USDT') return 1
      return tickers[`${coin}USDT`]?.price ?? tickers[coin]?.price ?? 0
    },
    [tickers],
  )

  // Sanal AMM bakiyeleri ayrı defterde tutulur (tradeStore.spotBalances'ta
  // değil) — cüzdanda görünmesi için ayrıca okunur.
  const loadVirtual = useCallback(() => {
    void getVirtualHoldings().then((h) => setVirtualHoldings(h))
  }, [])

  useEffect(() => {
    loadVirtual()
    const onFocus = loadVirtual
    const onVisibility = () => {
      if (document.visibilityState === 'visible') loadVirtual()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [loadVirtual])

  const totalDeposited = deposits.reduce((sum, d) => sum + d.amount, 0)

  const holdings = useMemo(() => {
    const rows = [
      { symbol: 'USDT', qty: balance, price: 1, avg: 1 },
      ...Object.entries(spotBalances).map(([coin, qty]) => ({
        symbol: coin,
        qty,
        price: priceOf(coin),
        avg: spotAvgCosts[coin] ?? 0,
      })),
    ].filter((r) => r.qty > 0)
    return rows.sort((a, b) => b.qty * b.price - a.qty * a.price)
  }, [spotBalances, balance, priceOf, spotAvgCosts])

  const totalValue = holdings.reduce((sum, h) => sum + h.qty * h.price, 0)

  const virtualRows = useMemo(() => {
    const rows = Object.entries(virtualHoldings)
      .filter(([, qty]) => qty > 0)
      .map(([coin, qty]) => ({
        symbol: coin,
        qty,
        price: priceOf(coin),
        avg: virtualAvgCosts[coin.toUpperCase()] ?? virtualAvgCosts[coin] ?? 0,
      }))
    return rows.sort((a, b) => b.qty * b.price - a.qty * a.price)
  }, [virtualHoldings, priceOf, virtualAvgCosts])

  const virtualTotal = virtualRows.reduce((sum, h) => sum + h.qty * h.price, 0)

  const apply = async () => {
    if (applying) return
    setApplying(true)
    try {
      // Hesap bazında tek-kullanım: hak önce Supabase'te işaretlenir
      // (başka cihazda kullanıldıysa bakiye işlenmez).
      const result = await redeemPromoAsync(code)
      if (result.ok) {
        setCode('')
        setMessage({ kind: 'success', text: `Tebrikler! +${result.amount} USDT hesabınıza eklendi.` })
        void syncDepositToSupabase({
          userId: getSessionUserId() ?? '',
          amountUsdt: result.amount,
          source: 'promo',
        })
        confetti({
          particleCount: 160,
          spread: 85,
          origin: { y: 0.6 },
          colors: ['#00e5ff', '#00c853', '#ffffff'],
        })
      } else {
        setMessage({ kind: 'error', text: result.error })
      }
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-exchange-border px-4 py-5 sm:px-6 sm:py-6">
        <h1 className="text-lg font-bold text-exchange-text">Cüzdan</h1>
        <p className="text-xs text-exchange-muted">Spot + Vadeli hesaplarınız</p>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-6 sm:py-6 lg:grid-cols-[1fr_2fr]">
        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:p-6">
          <div className="text-xs uppercase text-exchange-muted">Toplam Bakiye</div>
          <div className="mt-2 font-mono text-3xl font-bold text-exchange-text sm:text-4xl">
            {formatNumber(balance, 2)}{' '}
            <span className="text-lg text-exchange-yellow">USDT</span>
          </div>
          <div className="mt-3 text-xs text-exchange-muted">
            Toplam yatırılan: {formatNumber(totalDeposited, 2)} USDT
          </div>
          <div className="mt-1 text-xs text-exchange-muted">
            Kullanılan promosyon: {redeemedPromos.length} kod
          </div>
          <div className="mt-6 flex flex-row gap-2 sm:gap-3">
            <Button className="min-w-0 flex-1 whitespace-nowrap" size="lg" onClick={openDeposit}>
              + Para Yatır
            </Button>
            <Button variant="outline" className="min-w-0 flex-1 whitespace-nowrap" size="lg" onClick={openWithdraw}>
              - Para Çek
            </Button>
          </div>
        </section>

        <section className="rounded-2xl border border-exchange-border bg-exchange-card">
          <h2 className="border-b border-exchange-border px-5 py-3 text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Yatırma Geçmişi
          </h2>
          {deposits.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-exchange-muted">
              Henüz para yatırmadınız.
            </div>
          ) : (
            <ul>
              {deposits.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between border-b border-exchange-border/40 px-5 py-3 text-sm last:border-0"
                >
                  <div>
                    <div className="font-medium text-exchange-text">
                      {d.source === 'promo'
                        ? 'Promosyon kodu ile yükleme'
                        : d.source === 'referral'
                          ? 'Referans kodu ile yükleme'
                          : 'Kredi kartı ile yatırma'}
                    </div>
                    <div className="text-xs text-exchange-muted">
                      {new Date(d.at).toLocaleString('tr-TR')}
                    </div>
                  </div>
                  <div className="font-mono font-semibold text-exchange-buy">
                    +{formatNumber(d.amount, 2)} USDT
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="mx-4 mb-4 rounded-2xl border border-exchange-border bg-exchange-card sm:mx-6 sm:mb-6">
        <h2 className="border-b border-exchange-border px-4 py-3 text-sm font-bold uppercase tracking-wide text-exchange-muted sm:px-5">
          Çekim Geçmişi
        </h2>
        {withdrawals.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-exchange-muted">
            Henüz para çekmediniz.
          </div>
        ) : (
          <ul>
            {withdrawals.map((w) => (
              <li
                key={w.id}
                className="flex items-center justify-between border-b border-exchange-border/40 px-5 py-3 text-sm last:border-0"
              >
                <div>
                  <div className="font-medium text-exchange-text">Banka hesabına çekim</div>
                  <div className="text-xs text-exchange-muted">
                    {new Date(w.at).toLocaleString('tr-TR')}
                  </div>
                </div>
                <div className="font-mono font-semibold text-exchange-sell">
                  -{formatNumber(w.amount, 2)} USDT
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mx-4 mb-4 rounded-2xl border border-exchange-border bg-exchange-card sm:mx-6 sm:mb-6">
        <h2 className="border-b border-exchange-border px-4 py-3 text-sm font-bold uppercase tracking-wide text-exchange-muted sm:px-5">
          Spot Varlıklar
        </h2>
        {holdings.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-exchange-muted">
            Henüz coin satın almadınız. Spot sekmesinden ilk alımınızı yapın.
          </div>
        ) : (
          <>
            <div className="max-h-72 overflow-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="sticky top-0 bg-exchange-card">
                  <tr className="border-b border-exchange-border text-xs text-exchange-muted">
                    <th className="px-5 py-2 text-left font-medium">Varlık</th>
                    <th className="px-5 py-2 text-right font-medium">Miktar</th>
                    <th className="px-5 py-2 text-right font-medium">Ort. Maliyet</th>
                    <th className="px-5 py-2 text-right font-medium">Fiyat (USDT)</th>
                    <th className="px-5 py-2 text-right font-medium">Değer (USDT)</th>
                    <th className="px-5 py-2 text-right font-medium">K/Z</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => (
                    <tr
                      key={h.symbol}
                      className="border-b border-exchange-border/40 text-sm last:border-0"
                    >
                      <td className="px-5 py-2.5 font-medium text-exchange-text">{h.symbol}</td>
                      <td className="px-5 py-2.5 text-right font-mono">
                        {formatNumber(h.qty, h.symbol === 'USDT' ? 2 : 6)}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-exchange-muted">
                        {h.symbol === 'USDT' ? '—' : h.avg > 0 ? formatPrice(h.avg) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-exchange-muted">
                        {h.symbol === 'USDT' ? '—' : h.price > 0 ? formatPrice(h.price) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono font-semibold text-exchange-text">
                        {formatNumber(h.qty * h.price, 2)}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono">
                        {h.symbol === 'USDT' || !(h.avg > 0) || !(h.price > 0) ? (
                          <span className="text-exchange-muted">—</span>
                        ) : (
                          <PnlCell qty={h.qty} avg={h.avg} price={h.price} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-exchange-border px-5 py-3 text-sm">
              <span className="font-semibold text-exchange-muted">Toplam Değer</span>
              <span className="font-mono text-base font-bold text-exchange-yellow">
                {formatNumber(totalValue, 2)} USDT
              </span>
            </div>
          </>
        )}
      </section>

      <section className="mx-4 mb-4 rounded-2xl border border-exchange-border bg-exchange-card sm:mx-6 sm:mb-6">
        <div className="flex items-center justify-between gap-2 border-b border-exchange-border px-4 py-3 sm:px-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Sanal Varlıklar
          </h2>
          <button
            type="button"
            onClick={loadVirtual}
            className="shrink-0 whitespace-nowrap text-xs font-bold text-exchange-yellow hover:underline"
          >
            Yenile
          </button>
        </div>
        {virtualRows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-exchange-muted">
            Sanal piyasada coin tutmuyorsun. Piyasalar → sanal coinlerden alabilirsin.
          </div>
        ) : (
          <>
            <div className="max-h-72 overflow-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="sticky top-0 bg-exchange-card">
                  <tr className="border-b border-exchange-border text-xs text-exchange-muted">
                    <th className="px-5 py-2 text-left font-medium">Varlık</th>
                    <th className="px-5 py-2 text-right font-medium">Miktar</th>
                    <th className="px-5 py-2 text-right font-medium">Ort. Maliyet</th>
                    <th className="px-5 py-2 text-right font-medium">Fiyat (USDT)</th>
                    <th className="px-5 py-2 text-right font-medium">Değer (USDT)</th>
                    <th className="px-5 py-2 text-right font-medium">K/Z</th>
                  </tr>
                </thead>
                <tbody>
                  {virtualRows.map((h) => (
                    <tr
                      key={h.symbol}
                      className="border-b border-exchange-border/40 text-sm last:border-0"
                    >
                      <td className="px-5 py-2.5 font-medium text-exchange-text">{h.symbol}</td>
                      <td className="px-5 py-2.5 text-right font-mono">
                        {formatNumber(h.qty, 6)}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-exchange-muted">
                        {h.avg > 0 ? formatPrice(h.avg) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono text-exchange-muted">
                        {h.price > 0 ? formatPrice(h.price) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono font-semibold text-exchange-text">
                        {formatNumber(h.qty * h.price, 2)}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono">
                        {!(h.avg > 0) || !(h.price > 0) ? (
                          <span className="text-exchange-muted">—</span>
                        ) : (
                          <PnlCell qty={h.qty} avg={h.avg} price={h.price} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-exchange-border px-5 py-3 text-sm">
              <span className="font-semibold text-exchange-muted">Toplam Değer</span>
              <span className="font-mono text-base font-bold text-exchange-yellow">
                {formatNumber(virtualTotal, 2)} USDT
              </span>
            </div>
          </>
        )}
      </section>

      <DnzSection />

      <section className="mx-4 mb-4 rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:mx-6 sm:mb-6 sm:p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
          Promosyon Kodu Kullan
        </h2>        <p className="mt-1 text-xs text-exchange-muted">
          Kodu girip Uygula'ya basın — geçerli kodlara bonus USDT yüklenir. Her kod yalnızca bir kez
          kullanılabilir.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setMessage(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply()
            }}
            placeholder="Örn. dnztrd100"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 w-full rounded border border-exchange-border bg-exchange-bg px-3 text-base text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/60 sm:h-10 sm:w-56 sm:text-sm"
          />
          <Button onClick={() => void apply()} disabled={!code.trim() || applying} className="w-full sm:w-auto">
            {applying ? 'Kontrol ediliyor…' : 'Uygula'}
          </Button>
        </div>
        <AnimatePresence>
          {message && (
            <motion.div
              key={message.text}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={
                message.kind === 'success'
                  ? 'mt-3 rounded-lg bg-exchange-buy/10 px-3 py-2 text-sm font-semibold text-exchange-buy'
                  : 'mt-3 rounded-lg bg-exchange-sell/10 px-3 py-2 text-sm font-medium text-exchange-sell'
              }
            >
              {message.text}
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  )
}

/** Ortalama maliyete göre gerçekleşmemiş K/Z hücresi (yeşil/kırmızı). */
function PnlCell({ qty, avg, price }: { qty: number; avg: number; price: number }) {
  const pnl = (price - avg) * qty
  const pct = avg > 0 ? ((price - avg) / avg) * 100 : 0
  const up = pnl >= 0
  return (
    <span className={up ? 'font-semibold text-exchange-buy' : 'font-semibold text-exchange-sell'}>
      {up ? '+' : ''}
      {formatNumber(pnl, 2)} ({up ? '+' : ''}
      {formatNumber(pct, 2)}%)
    </span>
  )
}

const DNZ_TYPE_LABEL: Record<string, string> = {
  buy: 'Alış',
  sell: 'Satış',
  fee: 'Komisyon',
  fee_discount: 'Komisyon indirimi',
  transfer_in: 'Transfer (gelen)',
  transfer_out: 'Transfer (giden)',
  airdrop: 'Airdrop',
}

/**
 * DNZ borsa tokenı bölümü: simüle fiyat + bakiye + USDT takası +
 * komisyon indirimi tercihi + son hareketler.
 */
function DnzSection() {
  const dnzBalance = useDnzStore((s) => s.balance)
  const dnzAvg = useDnzStore((s) => s.avgCost)
  const dnzPrice = useDnzStore((s) => s.price)
  const payWithDnz = useDnzStore((s) => s.payWithDnz)
  const ledger = useDnzStore((s) => s.ledger)
  const tick = useDnzStore((s) => s.tick)
  const setPayWithDnz = useDnzStore((s) => s.setPayWithDnz)
  const refreshRemote = useDnzStore((s) => s.refreshRemote)
  const { buyForUsdt, sellQty: sellDnzQty } = useDnzTrade()
  const pushToast = useToastStore((s) => s.push)
  const [buyUsdt, setBuyUsdt] = useState('')
  const [sellQty, setSellQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    tick()
    void refreshRemote()
    const timer = window.setInterval(() => tick(), 30000)
    const onFocus = () => {
      tick()
      void refreshRemote()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [tick, refreshRemote])

  const buyPreview = parseFloat(buyUsdt.replace(',', '.'))
  const buyQty = Number.isFinite(buyPreview) && buyPreview > 0 && dnzPrice > 0 ? buyPreview / dnzPrice : 0
  const sellPreview = parseFloat(sellQty.replace(',', '.'))
  const sellUsdt = Number.isFinite(sellPreview) && sellPreview > 0 ? sellPreview * dnzPrice : 0
  const value = dnzBalance * dnzPrice

  const onBuy = () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const res = buyForUsdt(buyPreview)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setBuyUsdt('')
      pushToast({ message: res.message, tone: 'success' })
    } finally {
      setBusy(false)
    }
  }

  const onSell = () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const res = sellDnzQty(sellPreview)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setSellQty('')
      pushToast({ message: res.message, tone: 'success' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mx-4 mb-4 rounded-2xl border border-exchange-border bg-exchange-card sm:mx-6 sm:mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-exchange-border px-4 py-3 sm:px-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
          DNZ Token <span className="ml-1 rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-bold text-exchange-yellow">Borsa Tokenı</span>
        </h2>
        <span className="text-[11px] text-exchange-muted">Arz: {formatNumber(DNZ_TOTAL_SUPPLY, 0)} DNZ</span>
      </div>
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-exchange-text">{formatNumber(dnzBalance, 4)}</span>
            <span className="text-sm font-bold text-exchange-yellow">DNZ</span>
          </div>
          <div className="mt-1 text-xs text-exchange-muted">
            ≈ {formatNumber(value, 2)} USDT · Fiyat (simüle): {formatPrice(dnzPrice)} USDT
            {dnzAvg > 0 && <> · Ort. maliyet: {formatPrice(dnzAvg)} USDT</>}
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-xs font-semibold text-exchange-muted">
            <Toggle checked={payWithDnz} onChange={setPayWithDnz} label="Komisyonu DNZ ile öde" />
            Komisyonu DNZ ile öde (%25 indirim)
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-exchange-muted">
            Açıkken spot komisyonu (%0.1) indirimli olarak DNZ bakiyenden düşer. DNZ yetmezse komisyon USDT alınır.
          </p>
        </div>
        <div className="grid gap-3">
          <div className="rounded-xl border border-exchange-border/60 p-3">
            <label htmlFor="dnz-buy" className="mb-1 block text-xs font-semibold text-exchange-muted">
              DNZ Al {buyQty > 0 && <span className="text-exchange-text">≈ {formatNumber(buyQty, 4)} DNZ</span>}
            </label>
            <div className="flex gap-2">
              <input
                id="dnz-buy"
                value={buyUsdt}
                onChange={(e) => {
                  setBuyUsdt(e.target.value)
                  setError(null)
                }}
                inputMode="decimal"
                placeholder="USDT tutarı"
                disabled={busy}
                className="h-10 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50"
              />
              <Button size="sm" onClick={onBuy} disabled={busy || !(buyPreview > 0)}>
                {busy ? '…' : 'Al'}
              </Button>
            </div>
          </div>
          <div className="rounded-xl border border-exchange-border/60 p-3">
            <label htmlFor="dnz-sell" className="mb-1 block text-xs font-semibold text-exchange-muted">
              DNZ Sat {sellUsdt > 0 && <span className="text-exchange-text">≈ {formatNumber(sellUsdt, 2)} USDT</span>}
            </label>
            <div className="flex gap-2">
              <input
                id="dnz-sell"
                value={sellQty}
                onChange={(e) => {
                  setSellQty(e.target.value)
                  setError(null)
                }}
                inputMode="decimal"
                placeholder="DNZ miktarı"
                disabled={busy}
                className="h-10 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50"
              />
              <Button size="sm" variant="outline" onClick={onSell} disabled={busy || !(sellPreview > 0)}>
                {busy ? '…' : 'Sat'}
              </Button>
            </div>
          </div>
          {error && <p className="text-xs font-medium text-exchange-sell">{error}</p>}
        </div>
      </div>
      {ledger.length > 0 && (
        <div className="border-t border-exchange-border">
          <h3 className="px-4 pt-3 text-xs font-bold uppercase tracking-wide text-exchange-muted sm:px-5">
            Son DNZ Hareketleri
          </h3>
          <ul>
            {ledger.slice(0, 8).map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-2 border-b border-exchange-border/40 px-4 py-2 text-xs last:border-0 sm:px-5"
              >
                <div className="min-w-0">
                  <span className="font-semibold text-exchange-text">{DNZ_TYPE_LABEL[e.type] ?? e.type}</span>{' '}
                  <span className="text-exchange-muted">{new Date(e.at).toLocaleString('tr-TR')}</span>
                </div>
                <span className="shrink-0 font-mono font-semibold text-exchange-text">
                  {e.type === 'sell' || e.type === 'transfer_out' || e.type === 'fee' || e.type === 'fee_discount' ? '−' : '+'}
                  {formatNumber(e.amountDnz, 4)} DNZ
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}