import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn, formatNumber, formatPrice } from '@/lib/utils'
import { matchPairQuery } from '@/lib/coinSearch'
import { isDelisted } from '@/lib/delisted'
import { useFuturesSymbols } from '@/hooks/useFuturesSymbols'
import type { Ticker, TradingMode } from '@/types'

interface Props {
  symbol: string
  onSymbolChange: (symbol: string) => void
  tickers: Record<string, Ticker>
  live: boolean
  /** Vadeli modda long/short açılamayan coinler listelenmez. */
  mode?: TradingMode
  /** Sanal coin sembolleri (USDT soneki taşımaz, yine de listelenir). */
  virtualSymbols?: ReadonlySet<string>
}

export function PairSelector({ symbol, onSymbolChange, tickers, live, mode, virtualSymbols }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scopeRef = useRef<HTMLDivElement>(null)
  const futuresSymbols = useFuturesSymbols()

  const base = symbol.replace('USDT', '')

  // Vadeli mod + kontrat listesi biliniyorsa yalnızca vadeli kontratlar.
  // Liste bilinmiyorsa (çevrimdışı) filtre uygulanmaz — menü boş kalmaz.
  const allPairs = useMemo(() => {
    const entries = Object.values(tickers).filter(
      (t) =>
        (t.symbol.endsWith('USDT') || virtualSymbols?.has(t.symbol.toUpperCase())) &&
        !isDelisted(t.symbol),
    )
    const inFutures = mode === 'futures' && futuresSymbols
    const filtered = inFutures
      ? entries.filter((t) => futuresSymbols.has(t.symbol.toUpperCase()))
      : entries
    return filtered.sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [tickers, mode, futuresSymbols, virtualSymbols])

  const pairs = useMemo(() => {
    const q = query.trim().toLowerCase()
    const entries = q ? allPairs.filter((t) => matchPairQuery(t.symbol, q)) : allPairs
    return entries.slice(0, 300)
  }, [allPairs, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  // close on outside click
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={scopeRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex max-w-[10rem] items-center gap-1.5 overflow-hidden rounded-lg border px-2.5 py-1.5 text-sm font-bold transition-colors sm:max-w-none sm:px-3',
          open
            ? 'border-exchange-yellow/60 bg-exchange-yellow/10 text-exchange-text'
            : 'border-exchange-border text-exchange-text hover:border-exchange-muted',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="min-w-0 truncate">{base}/USDT</span>
        <span
          className={cn(
            'shrink-0 text-[10px] text-exchange-muted transition-transform',
            open && 'rotate-180',
          )}
        >
          ▼
        </span>
        {!live && (
          <span className="ml-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-exchange-yellow" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute left-0 top-full z-50 mt-2 w-[24rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-exchange-border bg-exchange-card shadow-2xl"
          >
            <div className="border-b border-exchange-border p-3">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-exchange-muted">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M20 20 L16.5 16.5" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Coin ara… (örn. SOL, ether, bitcoin)"
                  className="h-10 w-full rounded-lg border border-exchange-border bg-exchange-bg pl-9 pr-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow placeholder:text-exchange-muted/70"
                />
              </div>
            </div>

            <div className="flex items-center justify-between px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-exchange-muted">
              <span>Piyasa</span>
              <span>Fiyat · 24s</span>
            </div>

            <div role="listbox" className="max-h-[24rem] overflow-y-auto">
              {pairs.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-exchange-muted">
                  {query ? 'Sonuç bulunamadı.' : 'Piyasa verisi yükleniyor…'}
                </div>
              ) : (
                pairs.map((t) => {
                  const rowBase = t.symbol.replace('USDT', '')
                  const selected = t.symbol === symbol
                  const up = t.changePercent24h >= 0
                  return (
                    <button
                      key={t.symbol}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSymbolChange(t.symbol)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-exchange-surface',
                        selected && 'bg-exchange-yellow/5',
                      )}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-sm font-semibold text-exchange-text">
                          {rowBase}
                        </span>
                        <span className="text-[10px] text-exchange-muted">USDT</span>
                      </span>
                      <span className="text-right">
                        <span className="block font-mono text-sm font-semibold text-exchange-text">
                          {formatPrice(t.price)}
                        </span>
                        <span
                          className={cn(
                            'block font-mono text-xs font-medium',
                            up ? 'text-exchange-buy' : 'text-exchange-sell',
                          )}
                        >
                          {up ? '+' : ''}
                          {formatNumber(t.changePercent24h, 2)}%
                        </span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="flex items-center justify-between border-t border-exchange-border px-4 py-2 text-[10px] text-exchange-muted">
              <span>
                {mode === 'futures' && futuresSymbols
                  ? `${allPairs.length} vadeli kontrat`
                  : `${Object.keys(tickers).length} USDT çifti`}
              </span>
              <span className={cn('flex items-center gap-1', live ? 'text-exchange-buy' : 'text-exchange-sell')}>
                <span className={cn('h-1 w-1 rounded-full', live ? 'bg-exchange-buy' : 'bg-exchange-sell')} />
                {live ? 'CANLI' : 'BAĞLANTI KOPTU'}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}