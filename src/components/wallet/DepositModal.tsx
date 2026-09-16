import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Cards from 'react-credit-cards-2'
import 'react-credit-cards-2/dist/es/styles-compiled.css'
import confetti from 'canvas-confetti'
import { useTradeStore } from '@/store/tradeStore'
import { useUsdTryRate } from '@/hooks/useUsdTryRate'
import { getSessionUserId } from '@/services/authService'
import { quoteDeposit } from '@/services/rates'
import { assertDepositAllowed, getMoneyRestrictions, syncDepositToSupabase } from '@/services/supabaseWallet'
import {
  deleteSavedCard,
  getSavedCards,
  isExpiryValid,
  maskCardNumber,
  saveCard,
  type SavedCard,
} from '@/services/cards'
import { Button } from '@/components/ui/Button'
import { cn, formatNumber } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

const PRESETS = [1000, 5000, 10000, 50000]

/** How long the mock bank POS terminal "waits for approval". */
export const BANK_WAIT_MS = 5000

/** Test seam — production stays at BANK_WAIT_MS (exactly 10000 ms). */
export const bankWait = { ms: BANK_WAIT_MS }

type FocusField = 'number' | 'name' | 'expiry' | 'cvc' | ''

function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 16)
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ')
}

function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}/${digits.slice(2)}`
}

export function DepositModal({ open, onClose }: Props) {
  const deposit = useTradeStore((s) => s.deposit)
  const balance = useTradeStore((s) => s.balance)
  const { rate, live, refresh } = useUsdTryRate()

  const [number, setNumber] = useState('')
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cvc, setCvc] = useState('')
  const [focus, setFocus] = useState<FocusField>('')
  const [amountStr, setAmountStr] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [received, setReceived] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saveThisCard, setSaveThisCard] = useState(false)
  const [savedCards, setSavedCards] = useState<SavedCard[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const amountTry = parseFloat(amountStr) || 0
  const quote =
    amountTry > 0 && Number.isFinite(rate) && rate > 0
      ? quoteDeposit(amountTry, rate)
      : null

  useEffect(() => {
    if (open) {
      refresh()
      setSavedCards(getSavedCards())
    }
  }, [open, refresh])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const reset = () => {
    setNumber('')
    setName('')
    setExpiry('')
    setCvc('')
    setAmountStr('')
    setError(null)
    setLoading(false)
    setDone(false)
    setReceived(0)
    setSaveThisCard(false)
    setFocus('')
  }

  const handleClose = () => {
    if (loading) return
    reset()
    onClose()
  }

  const applySavedCard = (card: SavedCard) => {
    setNumber(formatCardNumber(card.number))
    setName(card.holderName.toUpperCase())
    setExpiry(card.expiry)
    setCvc('')
    setError(null)
    setFocus('cvc')
    setSavedCards(getSavedCards())
  }

  const removeSavedCard = (id: string) => {
    deleteSavedCard(id)
    setSavedCards(getSavedCards())
  }

  const cardFilled =
    number.replace(/\D/g, '').length >= 15 &&
    name.trim().length >= 2 &&
    cvc.length >= 3

  const submit = async () => {
    if (loading) return
    setError(null)

    if (!cardFilled) {
      setError('Lütfen kart bilgilerini eksiksiz girin.')
      return
    }
    if (!isExpiryValid(expiry)) {
      setError('Geçersiz veya süresi dolmuş kart')
      return
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      setError('Kur bilgisi alınamadı. Lütfen tekrar deneyin.')
      return
    }
    if (!quote || quote.netUsdt <= 0) {
      setError('Geçerli bir tutar girin.')
      return
    }

    // Admin kısıtı: para yatırması kapatılan hesap beklemeden durdurulur.
    try {
      const uid = getSessionUserId()
      if (uid) assertDepositAllowed(await getMoneyRestrictions(uid))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Para yatırma işlemin kısıtlanmış.')
      return
    }

    if (saveThisCard) {
      saveCard({
        holderName: name,
        number: number.replace(/\D/g, '').slice(0, 16),
        expiry,
      })
      setSavedCards(getSavedCards())
    }

    setLoading(true)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setLoading(false)
      setDone(true)
      setReceived(quote.netUsdt)
      deposit(quote.netUsdt)
      void syncDepositToSupabase({
        userId: getSessionUserId() ?? '',
        amountUsdt: quote.netUsdt,
        amountTry,
        rate,
        method: 'card',
        source: 'card',
      })
      confetti({
        particleCount: 140,
        spread: 75,
        origin: { y: 0.6 },
          colors: ['#00e5ff', '#00c853', '#ffffff'],
      })
    }, bankWait.ms)
  }

  const inputClass =
    'h-10 w-full rounded border border-exchange-border bg-exchange-surface px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/60'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-0 pb-safe sm:items-center sm:p-6"
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-exchange-border bg-exchange-card p-5 shadow-2xl sm:rounded-2xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-exchange-text">Para Yatırma</h2>
                <p className="text-xs text-exchange-muted">
                  Bakiyeniz: {formatNumber(balance, 2)} USDT
                </p>
              </div>
              <button
                onClick={handleClose}
                aria-label="Kapat"
                className="flex h-8 w-8 items-center justify-center rounded text-exchange-muted hover:bg-exchange-surface hover:text-exchange-text"
              >
                ✕
              </button>
            </div>

            <div className="mb-5 flex justify-center">
              <Cards
                number={number}
                name={name || 'KART SAHİBİ'}
                expiry={expiry || '••/••'}
                cvc={cvc || '•••'}
                focused={focus}
                preview
              />
            </div>

            <AnimatePresence initial={false}>
              {savedCards.length > 0 && !loading && !done && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-4 overflow-hidden"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-exchange-muted">
                      Kayıtlı Kartlarım
                    </span>
                    <span className="text-[10px] text-exchange-muted">
                      Tek tıkla doldur
                    </span>
                  </div>
                  <div className="space-y-2">
                    {savedCards.map((card) => (
                      <div
                        key={card.id}
                        className="flex items-center gap-2 rounded-lg border border-exchange-border bg-exchange-surface px-3 py-2"
                      >
                        <button
                          type="button"
                          onClick={() => applySavedCard(card)}
                          className="flex flex-1 items-center gap-3 text-left transition-colors hover:text-exchange-yellow"
                        >
                          <span className="rounded bg-exchange-yellow/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-exchange-yellow">
                            {card.brand}
                          </span>
                          <span className="font-mono text-xs font-semibold text-exchange-text">
                            {maskCardNumber(card.number)}
                          </span>
                          <span className="ml-auto text-xs text-exchange-muted">
                            {card.holderName.toUpperCase()} · {card.expiry}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`${maskCardNumber(card.number)} kartını sil`}
                          onClick={() => removeSavedCard(card.id)}
                          className="flex h-6 w-6 items-center justify-center rounded text-exchange-muted transition-colors hover:bg-exchange-sell/10 hover:text-exchange-sell"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-exchange-muted">Kart Numarası</label>
                  <input
                    value={number}
                    onChange={(e) => setNumber(formatCardNumber(e.target.value))}
                    onFocus={() => setFocus('number')}
                    onBlur={() => setFocus('')}
                    inputMode="numeric"
                    placeholder="XXXX XXXX XXXX XXXX"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-exchange-muted">Kart Sahibi</label>
                  <input
                    value={name}
                    onChange={(e) =>
                      setName(e.target.value.replace(/[^A-Za-zçÇğĞıİöÖşŞüÜ ]/g, '').toUpperCase())
                    }
                    onFocus={() => setFocus('name')}
                    onBlur={() => setFocus('')}
                    placeholder="AD SOYAD"
                    className={inputClass}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-exchange-muted">Son Kul.</label>
                    <input
                      value={expiry}
                      onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                      onFocus={() => setFocus('expiry')}
                      onBlur={() => setFocus('')}
                      placeholder="AA/YY"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-exchange-muted">CVC</label>
                    <input
                      value={cvc}
                      onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      onFocus={() => setFocus('cvc')}
                      onBlur={() => setFocus('')}
                      inputMode="numeric"
                      placeholder="•••"
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>

              <label className="flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-exchange-muted">
                <input
                  type="checkbox"
                  checked={saveThisCard}
                  onChange={(e) => setSaveThisCard(e.target.checked)}
                  disabled={loading}
                  className="h-4 w-4 accent-(--color-exchange-yellow)"
                />
                Bu kartı kaydet
              </label>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-exchange-muted">Tutar (TRY)</label>
                  <button
                    type="button"
                    onClick={refresh}
                    className="flex items-center gap-1 text-[10px] text-exchange-muted hover:text-exchange-yellow"
                    title="Kuru güncelle"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M20 4v5h-5M4 20v-5h5" strokeLinecap="round" />
                      <path d="M18.5 9A7 7 0 0 0 6 6.5M5.5 15A7 7 0 0 0 18 17.5" strokeLinecap="round" />
                    </svg>
                    {live ? `Kur: ${formatNumber(rate, 4)}` : 'Kur yükleniyor…'}
                  </button>
                </div>
                <input
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  onFocus={() => setFocus('')}
                  inputMode="decimal"
                  placeholder="örn. 34000"
                  className={cn(inputClass, 'font-mono')}
                />
                <div className="mt-2 flex gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p}
                      onClick={() => setAmountStr(String(p))}
                      className={cn(
                        'flex-1 rounded border px-1 py-1.5 text-xs font-semibold transition-colors',
                        amountStr === String(p)
                          ? 'border-exchange-yellow bg-exchange-yellow/10 text-exchange-yellow'
                          : 'border-exchange-border text-exchange-muted hover:border-exchange-muted',
                      )}
                    >
                      ₺{formatNumber(p, 0)}
                    </button>
                  ))}
                </div>
              </div>

              <AnimatePresence>
                {quote && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-2 rounded-xl border border-exchange-border bg-exchange-bg p-4 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-exchange-muted">Kur</span>
                        <span className="font-mono text-exchange-text">
                          1 USDT = {formatNumber(rate, 4)} ₺
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-exchange-muted">Girdiğiniz Tutar</span>
                        <span className="font-mono text-exchange-text">
                          {formatNumber(amountTry, 2)} ₺
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-exchange-sell">Ağ Komisyonu (%1,5)</span>
                        <span className="font-mono text-exchange-sell">
                          −{formatNumber(quote.fee, 2)} ₺
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t border-exchange-border pt-2">
                        <span className="font-semibold text-exchange-text">
                          Hesaba Geçecek
                        </span>
                        <motion.span
                          key={quote.netUsdt.toFixed(4)}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="font-mono text-base font-bold text-exchange-buy"
                        >
                          {formatNumber(quote.netUsdt, 2)} USDT
                        </motion.span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

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

              <div className="min-h-[96px]">
                {loading ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center justify-center gap-2 rounded-xl border border-exchange-yellow/30 bg-exchange-yellow/5 px-4 py-6"
                  >
                    <span className="h-9 w-9 animate-spin rounded-full border-2 border-exchange-yellow border-t-transparent" />
                    <p className="text-sm font-semibold text-exchange-text">
                      Banka onayı bekleniyor…
                    </p>
                    <p className="text-xs text-exchange-muted">
                      Lütfen sayfadan ayrılmayın.
                    </p>
                  </motion.div>
                ) : done ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex h-12 items-center justify-center rounded bg-exchange-buy/10 font-semibold text-exchange-buy"
                  >
                    ✓ +{formatNumber(received, 2)} USDT bakiyenize eklendi
                  </motion.div>
                ) : (
                  <Button className="w-full" size="lg" onClick={submit}>
                    {quote ? `${formatNumber(quote.netUsdt, 2)} USDT Yatır` : 'Para Yatır'}
                  </Button>
                )}
              </div>

              {done && (
                <Button variant="outline" className="w-full" onClick={handleClose}>
                  Kapat
                </Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}