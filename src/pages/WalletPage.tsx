import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import confetti from 'canvas-confetti'
import { useTradeStore } from '@/store/tradeStore'
import { useUiStore } from '@/store/uiStore'
import { useAllTickers } from '@/hooks/useAllTickers'
import { getSessionUserId } from '@/services/authService'
import { syncDepositToSupabase } from '@/services/supabaseWallet'
import { formatNumber, formatPrice } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

export function WalletPage() {
  const balance = useTradeStore((s) => s.balance)
  const deposits = useTradeStore((s) => s.deposits)
  const withdrawals = useTradeStore((s) => s.withdrawals)
  const redeemedPromos = useTradeStore((s) => s.promos)
  const spotBalances = useTradeStore((s) => s.spotBalances)
  const redeemPromoAsync = useTradeStore((s) => s.redeemPromoAsync)
  const openDeposit = useUiStore((s) => s.openDeposit)
  const openWithdraw = useUiStore((s) => s.openWithdraw)

  const { tickers } = useAllTickers()

  const [code, setCode] = useState('')
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  )

  const totalDeposited = deposits.reduce((sum, d) => sum + d.amount, 0)

  const holdings = useMemo(() => {
    const rows = [
      { symbol: 'USDT', qty: balance, price: 1 },
      ...Object.entries(spotBalances).map(([coin, qty]) => ({
        symbol: coin,
        qty,
        price: tickers[`${coin}USDT`]?.price ?? 0,
      })),
    ].filter((r) => r.qty > 0)
    return rows.sort((a, b) => b.qty * b.price - a.qty * a.price)
  }, [spotBalances, balance, tickers])

  const totalValue = holdings.reduce((sum, h) => sum + h.qty * h.price, 0)

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
          colors: ['#f0b90b', '#0ecb81', '#ffffff'],
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
              <table className="w-full min-w-[26rem] text-sm">
                <thead className="sticky top-0 bg-exchange-card">
                  <tr className="border-b border-exchange-border text-xs text-exchange-muted">
                    <th className="px-5 py-2 text-left font-medium">Varlık</th>
                    <th className="px-5 py-2 text-right font-medium">Miktar</th>
                    <th className="px-5 py-2 text-right font-medium">Fiyat (USDT)</th>
                    <th className="px-5 py-2 text-right font-medium">Değer (USDT)</th>
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
                        {h.symbol === 'USDT' ? '—' : h.price > 0 ? formatPrice(h.price) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono font-semibold text-exchange-text">
                        {formatNumber(h.qty * h.price, 2)}
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

      <section className="mx-4 mb-4 rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:mx-6 sm:mb-6 sm:p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
          Promosyon Kodu Kullan
        </h2>
        <p className="mt-1 text-xs text-exchange-muted">
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