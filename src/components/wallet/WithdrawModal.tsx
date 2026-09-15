import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTradeStore } from '@/store/tradeStore'
import { getSessionUserId } from '@/services/authService'
import { assertWithdrawAllowed, getMoneyRestrictions, syncWithdrawToSupabase } from '@/services/supabaseWallet'
import {
  deleteSavedWithdrawMethod,
  getSavedWithdrawMethods,
  maskWithdrawAccount,
  saveWithdrawMethod,
  type SavedWithdrawMethod,
} from '@/services/withdrawMethods'
import { Button } from '@/components/ui/Button'
import { cn, formatNumber, roundTo } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

/** How long the mock bank transfer "takes" before the balance is updated. */
export const TRANSFER_WAIT_MS = 4000

/** Test seam — production stays at TRANSFER_WAIT_MS (exactly 4000 ms). */
export const transferWait = { ms: TRANSFER_WAIT_MS }

type Method = 'card' | 'iban'

function formatAccount(raw: string, method: Method): string {
  if (method === 'card') {
    const digits = raw.replace(/\D/g, '').slice(0, 16)
    return digits.replace(/(.{4})(?=.)/g, '$1 ')
  }
  const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 26)
  return value.replace(/(.{4})(?=.)/g, '$1 ')
}

function isValidAccount(value: string, method: Method): boolean {
  const cleaned = value.replace(/\s/g, '')
  if (method === 'card') {
    return /^\d{15,16}$/.test(cleaned)
  }
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,}$/.test(cleaned)
}

export function WithdrawModal({ open, onClose }: Props) {
  const balance = useTradeStore((s) => s.balance)
  const withdraw = useTradeStore((s) => s.withdraw)

  const [method, setMethod] = useState<Method>('card')
  const [accountNumber, setAccountNumber] = useState('')
  const [name, setName] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [withdrawn, setWithdrawn] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [savedMethods, setSavedMethods] = useState<SavedWithdrawMethod[]>([])
  const [methodsOpen, setMethodsOpen] = useState(false)
  const [saveThisMethod, setSaveThisMethod] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) setSavedMethods(getSavedWithdrawMethods())
  }, [open])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const reset = () => {
    setMethod('card')
    setAccountNumber('')
    setName('')
    setAmountStr('')
    setError(null)
    setLoading(false)
    setDone(false)
    setWithdrawn(0)
    setSaveThisMethod(false)
    setMethodsOpen(false)
  }

  const handleClose = () => {
    if (loading) return
    reset()
    onClose()
  }

  const applySavedMethod = (saved: SavedWithdrawMethod) => {
    setMethod(saved.method)
    setAccountNumber(formatAccount(saved.accountNumber, saved.method))
    setName(saved.holderName.toUpperCase())
    setSaveThisMethod(false)
    setMethodsOpen(false)
    setError(null)
  }

  const removeSavedMethod = (id: string) => {
    deleteSavedWithdrawMethod(id)
    setSavedMethods(getSavedWithdrawMethods())
  }

  const amount = parseFloat(amountStr)
  const amountToWithdraw = Number.isFinite(amount) ? roundTo(amount) : 0

  const submit = async () => {
    if (loading) return
    setError(null)

    if (!isValidAccount(accountNumber, method)) {
      setError(
        method === 'card'
          ? 'Lütfen geçerli bir kart numarası girin.'
          : 'Lütfen geçerli bir IBAN girin.',
      )
      return
    }
    if (name.trim().length < 2) {
      setError('Lütfen alıcı ad soyadını girin.')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Lütfen geçerli bir tutar girin.')
      return
    }
    if (amountToWithdraw > balance) {
      setError('Yetersiz Bakiye')
      return
    }

    // Admin kısıtı: para çekmesi kapatılan hesap beklemeden durdurulur.
    try {
      const uid = getSessionUserId()
      if (uid) assertWithdrawAllowed(await getMoneyRestrictions(uid))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Para çekme işlemin kısıtlanmış.')
      return
    }

    if (saveThisMethod) {
      saveWithdrawMethod({ method, accountNumber, holderName: name })
      setSavedMethods(getSavedWithdrawMethods())
    }

    setLoading(true)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setLoading(false)
      setDone(true)
      setWithdrawn(amountToWithdraw)
      withdraw(amountToWithdraw)
      void syncWithdrawToSupabase({
        userId: getSessionUserId() ?? '',
        amountUsdt: amountToWithdraw,
      })
    }, transferWait.ms)
  }

  const inputClass =
    'h-10 w-full rounded border border-exchange-border bg-exchange-surface px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/60'

  const accountLabel = method === 'card' ? 'Kart Numarası' : 'IBAN Numarası'
  const accountPlaceholder =
    method === 'card' ? 'XXXX XXXX XXXX XXXX' : 'TR00 0000 0000 0000 0000 0000'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6"
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
                <h2 className="text-lg font-bold text-exchange-text">Para Çekme</h2>
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

            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {savedMethods.length > 0 && !loading && !done && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setMethodsOpen((v) => !v)}
                      aria-expanded={methodsOpen}
                      className="flex w-full items-center justify-between rounded-lg border border-exchange-border bg-exchange-surface px-3 py-2 text-sm font-semibold text-exchange-text transition-colors hover:border-exchange-muted"
                    >
                      <span>Kayıtlı Yöntemlerim ({savedMethods.length})</span>
                      <span className="text-exchange-muted">{methodsOpen ? '▲' : '▼'}</span>
                    </button>
                    <AnimatePresence initial={false}>
                      {methodsOpen && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-2 max-h-44 space-y-2 overflow-y-auto">
                            {savedMethods.map((m) => {
                              const masked = maskWithdrawAccount(m.method, m.accountNumber)
                              return (
                                <div
                                  key={m.id}
                                  className="flex items-center gap-2 rounded-lg border border-exchange-border bg-exchange-surface px-3 py-2"
                                >
                                  <button
                                    type="button"
                                    onClick={() => applySavedMethod(m)}
                                    className="flex flex-1 items-center gap-3 text-left transition-colors hover:text-exchange-yellow"
                                  >
                                    <span className="rounded bg-exchange-yellow/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-exchange-yellow">
                                      {m.method === 'card' ? 'Kart' : 'IBAN'}
                                    </span>
                                    <span className="font-mono text-xs font-semibold text-exchange-text">
                                      {masked}
                                    </span>
                                    <span className="ml-auto text-xs text-exchange-muted">
                                      {m.holderName.toUpperCase()}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`${masked} kayıtlı yöntemini sil`}
                                    onClick={() => removeSavedMethod(m.id)}
                                    className="flex h-6 w-6 items-center justify-center rounded text-exchange-muted transition-colors hover:bg-exchange-sell/10 hover:text-exchange-sell"
                                  >
                                    ✕
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>

              <div>
                <label className="mb-1 block text-xs text-exchange-muted">Çekim Yöntemi</label>
                <div className="flex gap-2">
                  {(
                    [
                      { value: 'card', label: 'Banka Kartı' },
                      { value: 'iban', label: 'IBAN' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => {
                        setMethod(m.value)
                        setAccountNumber('')
                        setError(null)
                      }}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
                        method === m.value
                          ? 'border-exchange-yellow bg-exchange-yellow/10 text-exchange-yellow'
                          : 'border-exchange-border text-exchange-muted hover:border-exchange-muted',
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-exchange-muted">{accountLabel}</label>
                <input
                  value={accountNumber}
                  onChange={(e) => {
                    setAccountNumber(formatAccount(e.target.value, method))
                    setError(null)
                  }}
                  inputMode={method === 'card' ? 'numeric' : 'text'}
                  placeholder={accountPlaceholder}
                  className={cn(inputClass, 'font-mono')}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-exchange-muted">Alıcı Ad Soyad</label>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(
                      e.target.value.replace(/[^A-Za-zçÇğĞıİöÖşŞüÜ ]/g, '').toUpperCase(),
                    )
                    setError(null)
                  }}
                  placeholder="AD SOYAD"
                  className={inputClass}
                />
              </div>

              <label className="flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-exchange-muted">
                <input
                  type="checkbox"
                  checked={saveThisMethod}
                  onChange={(e) => setSaveThisMethod(e.target.checked)}
                  disabled={loading}
                  className="h-4 w-4 accent-(--color-exchange-yellow)"
                />
                {method === 'card' ? 'Bu kartı kaydet' : 'Bu IBAN’ı kaydet'}
              </label>

              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="text-xs text-exchange-muted">Çekilecek Tutar (USDT)</label>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-exchange-muted">
                      Kullanılabilir: {formatNumber(balance, 2)} USDT
                    </span>
                    <button
                      type="button"
                      onClick={() => setAmountStr(balance.toFixed(2))}
                      className="text-xs font-semibold text-exchange-yellow hover:underline"
                    >
                      Tümünü Çek
                    </button>
                  </div>
                </div>
                <input
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  inputMode="decimal"
                  placeholder="örn. 250"
                  className={cn(inputClass, 'font-mono')}
                />
              </div>

              <AnimatePresence>
                {amountToWithdraw > 0 && amountToWithdraw <= balance && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-center justify-between rounded-xl border border-exchange-border bg-exchange-bg px-3 py-2.5 text-sm">
                      <span className="text-exchange-muted">Çekim Sonrası Bakiye</span>
                      <span className="font-mono font-semibold text-exchange-text">
                        {formatNumber(Math.max(0, balance - amountToWithdraw), 2)} USDT
                      </span>
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
                      Hesabınıza transfer ediliyor…
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
                    ✓ {formatNumber(withdrawn, 2)} USDT bakiyenizden çekildi
                  </motion.div>
                ) : (
                  <Button className="w-full" size="lg" onClick={submit}>
                    Çekim Talebi Gönder
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