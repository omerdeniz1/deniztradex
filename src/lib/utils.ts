import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits }).format(value)
}

/** Round to a fixed number of decimals, avoiding long float artifacts. */
export function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

export function formatPnl(value: number) {
  return new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatPrice(value: number) {
  if (value >= 1000) return formatNumber(value, 2)
  if (value >= 1) return formatNumber(value, 4)
  return formatNumber(value, 6)
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat('tr-TR', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatSignedPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${formatNumber(value, 2)}%`
}

/**
 * Bekleyen-emir bekçisi için fiyat çözümleme: canlı soket birincil,
 * toplu ticker anlık görüntüsü yedek. Soketi olmayan sembollerde
 * (örn. simüle fiyatlı DNZ) emirler yedek fiyatla ateşlenir — yoksa
 * sonsuza dek askıda kalırlardı.
 */
export function resolveLivePrice(
  symbol: string,
  livePrices: Record<string, number>,
  tickers?: Record<string, { price?: number } | null | undefined>,
): number {
  const live = livePrices[symbol] ?? 0
  if (live > 0) return live
  const snap = tickers?.[symbol]?.price ?? 0
  return snap > 0 ? snap : 0
}

export function formatTime(value: number) {
  return new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}