import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useToastStore } from '@/store/toastStore'
import {
  getMyWalletNo,
  listTransferHistory,
  listTransferableAssets,
  lookupTransferTarget,
  transferAsset,
  TRANSFER_FEE_RATE,
  transferFeeFor,
  transferTotalFor,
  type TransferRecord,
  type TransferTarget,
} from '@/services/transferService'
import { cn, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { CustomSelect } from '@/components/ui/CustomSelect'

export function TransferPage() {
  const pushToast = useToastStore((s) => s.push)
  const [walletNo, setWalletNo] = useState('')
  const [receiverInput, setReceiverInput] = useState('')
  const [target, setTarget] = useState<TransferTarget | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [assets, setAssets] = useState<{ asset: string; qty: number; kind: string }[]>([])
  const [asset, setAsset] = useState('USDT')
  const [amountStr, setAmountStr] = useState('')
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<TransferRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setWalletNo(await getMyWalletNo())
    } catch {
      setWalletNo('')
    }
    try {
      setAssets(await listTransferableAssets())
    } catch {
      setAssets([{ asset: 'USDT', qty: 0, kind: 'usdt' }])
    }
    setHistoryLoading(true)
    try {
      setHistory(await listTransferHistory(20))
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const selected = useMemo(
    () => assets.find((a) => a.asset === asset) ?? { asset, qty: 0, kind: 'usdt' },
    [assets, asset],
  )
  const amount = parseFloat(amountStr.replace(',', '.'))

  const verify = async () => {
    if (verifying || !receiverInput.trim()) return
    setVerifying(true)
    setError(null)
    try {
      setTarget(await lookupTransferTarget(receiverInput))
    } catch (err) {
      setTarget(null)
      setError(err instanceof Error ? err.message : 'Alıcı bulunamadı.')
    } finally {
      setVerifying(false)
    }
  }

  const copyWallet = async () => {
    if (!walletNo) return
    try {
      await navigator.clipboard.writeText(walletNo)
      pushToast({ message: 'Cüzdan numaran kopyalandı.', tone: 'success' })
    } catch {
      pushToast({ message: walletNo, tone: 'info' })
    }
  }

  const send = async () => {
    if (busy) return
    setError(null)
    if (!target) {
      setError('Önce alıcıyı doğrula.')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Geçerli bir tutar gir.')
      return
    }
    if (transferTotalFor(amount, asset) > selected.qty) {
      setError(`Yetersiz ${asset} bakiyesi (tutar + %1.2 ücret).`)
      return
    }
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    try {
      const res = await transferAsset(target.walletNo, asset, amount)
      setAmountStr('')
      setArmed(false)
      const fee = res.fee ?? transferFeeFor(amount, asset)
      pushToast({
        message: `${formatNumber(res.amount, res.asset === 'USDT' ? 2 : 6)} ${res.asset} → ${target.username} gönderildi (ücret: ${formatNumber(fee, res.asset === 'USDT' ? 2 : 6)}).`,
        tone: 'success',
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer yapılamadı.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-exchange-border px-4 py-5 sm:px-6 sm:py-6">
        <h1 className="text-lg font-bold text-exchange-text">Transfer</h1>
        <p className="text-xs text-exchange-muted">Hesaplar arası USDT ve coin gönderimi</p>
      </div>

      <div className="w-full max-w-2xl space-y-4 px-4 py-4 sm:space-y-6 sm:px-6 sm:py-6">
        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Cüzdan Numaran
          </h2>
          <p className="mt-1 text-xs text-exchange-muted">
            Başkaları sana bu numarayla (veya kullanıcı adınla) gönderebilir.
          </p>
          <div className="mt-3 flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-xl border border-exchange-border bg-exchange-bg px-3 py-2.5 font-mono text-base font-extrabold tracking-wider text-exchange-yellow">
              {walletNo || '…'}
            </span>
            <Button size="sm" variant="outline" onClick={() => void copyWallet()} disabled={!walletNo}>
              Kopyala
            </Button>
          </div>
        </section>

        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Yeni Transfer
          </h2>
          <div className="mt-4 grid gap-3">
            <div className="min-w-0">
              <label htmlFor="transfer-to" className="mb-1 block text-xs font-semibold text-exchange-muted">
                Alıcı (cüzdan numarası veya kullanıcı adı)
              </label>
              <div className="flex min-w-0 gap-2">
                <input
                  id="transfer-to"
                  value={receiverInput}
                  onChange={(e) => {
                    setReceiverInput(e.target.value)
                    setTarget(null)
                    setArmed(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void verify()
                  }}
                  placeholder="örn. WT-1A2B3C4D"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-exchange-border bg-exchange-bg px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
                />
                <Button size="md" variant="outline" onClick={() => void verify()} disabled={verifying || !receiverInput.trim()} className="shrink-0 whitespace-nowrap">
                  {verifying ? '…' : 'Doğrula'}
                </Button>
              </div>
              {target && (
                <p className="mt-1.5 text-xs text-exchange-muted">
                  Alıcı:{' '}
                  <span className="font-bold text-exchange-buy">{target.username}</span>{' '}
                  <span className="font-mono text-exchange-muted">{target.walletNo}</span>
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <label className="mb-1 block text-xs font-semibold text-exchange-muted">Varlık</label>
                <CustomSelect
                  value={asset}
                  onChange={(v) => {
                    setAsset(v)
                    setArmed(false)
                  }}
                  label="Transfer varlığı"
                  className="h-11 w-full cursor-pointer rounded-xl border border-exchange-border bg-exchange-bg px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow"
                  options={assets.map((a) => ({
                    v: a.asset,
                    l: `${a.asset} — ${formatNumber(a.qty, a.asset === 'USDT' ? 2 : 6)}`,
                  }))}
                />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label htmlFor="transfer-amount" className="text-xs font-semibold text-exchange-muted">
                    Tutar
                  </label>
                  <button
                    type="button"
                    onClick={() => setAmountStr(String(Math.round(selected.qty * 100) / 100))}
                    className="shrink-0 text-xs font-bold text-exchange-yellow hover:underline"
                  >
                    Max
                  </button>
                </div>
                <input
                  id="transfer-amount"
                  value={amountStr}
                  onChange={(e) => {
                    setAmountStr(e.target.value)
                    setArmed(false)
                  }}
                  inputMode="decimal"
                  placeholder="0.00"
                  disabled={busy}
                  className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 font-mono text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
                />
              </div>
            </div>

            {target && Number.isFinite(amount) && amount > 0 && (
              <div className="rounded-xl bg-exchange-surface px-3 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="shrink-0 text-exchange-muted">Alıcı alır</span>
                  <span className="min-w-0 truncate text-right font-mono font-semibold text-exchange-text">
                    {formatNumber(amount, asset === 'USDT' ? 2 : 6)} {asset} → {target.username}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs">
                  <span className="shrink-0 text-exchange-muted">
                    İşlem ücreti (%{(TRANSFER_FEE_RATE * 100).toLocaleString('tr-TR')})
                  </span>
                  <span className="min-w-0 truncate text-right font-mono text-exchange-muted">
                    {formatNumber(transferFeeFor(amount, asset), asset === 'USDT' ? 2 : 6)} {asset}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs">
                  <span className="shrink-0 font-bold text-exchange-muted">Bakiyenden düşer</span>
                  <span className="min-w-0 truncate text-right font-mono font-bold text-exchange-yellow">
                    {formatNumber(transferTotalFor(amount, asset), asset === 'USDT' ? 2 : 6)} {asset}
                  </span>
                </div>
              </div>
            )}

            <AnimatePresence>
              {error && (
                <motion.div
                  key={error}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="rounded-lg bg-exchange-sell/10 px-3 py-2 text-sm font-medium text-exchange-sell"
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <div>
              <Button
                size="lg"
                onClick={() => void send()}
                disabled={busy || !target || !Number.isFinite(amount) || amount <= 0}
                className={cn('w-full', armed && 'border border-exchange-sell/60')}
              >
                {busy ? 'Gönderiliyor…' : armed ? 'Emin misin? Onayla ve Gönder' : 'Gönder'}
              </Button>
              {armed && (
                <button
                  type="button"
                  onClick={() => setArmed(false)}
                  className="mt-2 w-full text-center text-xs font-semibold text-exchange-muted hover:text-exchange-text"
                >
                  Vazgeç
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
          <h2 className="border-b border-exchange-border px-5 py-3 text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Transfer Geçmişi
          </h2>
          {historyLoading ? (
            <div className="px-5 py-8 text-center text-sm text-exchange-muted">Yükleniyor…</div>
          ) : history.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-exchange-muted">
              Henüz transfer yapmadın.
            </div>
          ) : (
            <ul>
              {history.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-3 border-b border-exchange-border/40 px-5 py-3 text-sm last:border-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-exchange-text">
                      {h.direction === 'in' ? 'Gelen' : 'Giden'} · {h.asset}
                      {h.counterparty ? (
                        <span className="text-exchange-muted"> · {h.counterparty}</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-exchange-muted">
                      {h.at > 0 ? new Date(h.at).toLocaleString('tr-TR') : ''}
                    </div>
                  </div>
                  <div
                    className={cn(
                      'shrink-0 whitespace-nowrap font-mono font-semibold',
                      h.direction === 'in' ? 'text-exchange-buy' : 'text-exchange-sell',
                    )}
                  >
                    {h.direction === 'in' ? '+' : '-'}
                    {formatNumber(h.amount, h.asset === 'USDT' ? 2 : 6)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
