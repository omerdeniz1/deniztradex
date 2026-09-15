/**
 * Grafik indikatörleri — saf fonksiyonlar (girdi dizisini değiştirmez).
 * Dönen diziler girdiyle aynı uzunluktadır; yeterli veri yoksa ilgili
 * indisler `null` olur. lightweight-charts tarafı null'ları atlar.
 */

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (period <= 0 || values.length < period) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (period <= 0 || values.length < period) return out
  const k = 2 / (period + 1)
  // Standart tohumlama: ilk EMA = ilk `period` değerin SMA'si.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export interface BollingerBands {
  readonly basis: (number | null)[]
  readonly upper: (number | null)[]
  readonly lower: (number | null)[]
}

export function boll(
  values: number[],
  period = 20,
  mult = 2,
): BollingerBands {
  const basis = sma(values, period)
  const upper: (number | null)[] = new Array(values.length).fill(null)
  const lower: (number | null)[] = new Array(values.length).fill(null)
  if (period <= 0 || values.length < period) return { basis, upper, lower }
  for (let i = period - 1; i < values.length; i++) {
    const mean = basis[i]
    if (mean === null) continue
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) {
      variance += (values[j] - mean) ** 2
    }
    const sd = Math.sqrt(variance / period)
    upper[i] = mean + mult * sd
    lower[i] = mean - mult * sd
  }
  return { basis, upper, lower }
}

/** Dizideki son null-olmayan değer (lejant için). */
export function lastDefined(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i] as number
  }
  return null
}
