import { fetchSymbolPrice } from '@/services/binance'

const FEE_RATE = 0.015

interface FrankfurterResponse {
  rates?: Record<string, number>
}

/**
 * Canlı USDT→TRY kuru Binance spot takasındaki USDTTRY fiyatından çekilir.
 * Binance üzerinden fiyat alınamazsa ECB verisine (Frankfurter) düşülür;
 * tüm kaynaklar başarısız olursa hata fırlatılır.
 */
export async function fetchUsdTryRate(): Promise<number> {
  const binance = await fetchSymbolPrice('USDTTRY')
  const binanceRate = binance ? parseFloat(binance.price) : NaN
  if (Number.isFinite(binanceRate) && binanceRate > 0) return binanceRate

  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=TRY')
    if (res.ok) {
      const data = (await res.json()) as FrankfurterResponse
      const rate = data.rates?.TRY
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
        return rate
      }
    }
  } catch {
    // all sources unreachable — fail loudly below
  }
  throw new Error('USDT/TRY kuru alınamadı')
}

export interface DepositQuote {
  rate: number
  feeRate: number
  fee: number
  netUsdt: number
}

/** TRY miktarından %1,5 ağ komisyonu kesilip kur üzerinden USDT'ye çevrilir. */
export function quoteDeposit(amountTry: number, rate: number): DepositQuote {
  const fee = amountTry * FEE_RATE
  const netTry = amountTry - fee
  return {
    rate,
    feeRate: FEE_RATE,
    fee,
    netUsdt: netTry / rate,
  }
}