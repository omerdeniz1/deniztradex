/**
 * Alım-satım komisyon motoru (saf matematik, yan etki yok).
 *
 * - Spot işlem komisyonu: `SPOT_FEE_RATE` (%0.1, işlem tutarı üzerinden).
 *   DNZ/USDT sanal havuzda işlem görür (%0.3 havuz ücreti fiyatın
 *   içindedir); spot komisyonu uygulanmaz.
 * - DNZ ile ödeme: `DNZ_FEE_DISCOUNT` (%25) indirimli tutar, güncel DNZ
 *   fiyatından DNZ cinsinden düşülür (BNB modeli).
 * - DNZ yetersizse / fiyat yoksa sessizce USDT komisyonuna düşülür —
 *   işlem asla sırf indirim yüzünden durmaz.
 */

export const SPOT_FEE_RATE = 0.001
export const DNZ_FEE_DISCOUNT = 0.25

export interface FeeQuoteInput {
  /** Komisyon DNZ ile ödensin mi? (kullanıcı tercihi) */
  payWithDnz: boolean
  /** Kullanıcının DNZ bakiyesi (adet). */
  dnzBalance: number
  /** Güncel DNZ fiyatı (USDT). */
  dnzPrice: number
}

export interface FeeQuote {
  /** İşlem tutarı (USDT). */
  readonly notional: number
  /** Standart komisyon (USDT). */
  readonly feeUsdt: number
  /** DNZ ile ödeme aktif ve karşılanabiliyor mu? */
  readonly useDnz: boolean
  /** DNZ ile ödenecek indirimli tutarın USDT karşılığı. */
  readonly discountedUsdt: number
  /** Düşülecek DNZ adedi (`useDnz` ise > 0). */
  readonly feeDnz: number
  /** USDT bakiyeden ayrıca düşülecek komisyon (`useDnz` ise 0). */
  readonly usdtCharge: number
}

/** Hafif yuvarlama — float artıklarının bakiyede birikmemesi için. */
export function roundFee(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

export function quoteSpotFee(notional: number, input: FeeQuoteInput): FeeQuote {
  const clean = Number.isFinite(notional) && notional > 0 ? notional : 0
  const feeUsdt = roundFee(clean * SPOT_FEE_RATE)
  const discountedUsdt = roundFee(feeUsdt * (1 - DNZ_FEE_DISCOUNT))
  const price = Number.isFinite(input.dnzPrice) && input.dnzPrice > 0 ? input.dnzPrice : 0
  const balance = Number.isFinite(input.dnzBalance) && input.dnzBalance > 0 ? input.dnzBalance : 0
  const feeDnz = price > 0 ? roundFee(discountedUsdt / price) : 0
  const useDnz = input.payWithDnz && feeDnz > 0 && balance >= feeDnz
  return {
    notional: clean,
    feeUsdt,
    useDnz,
    discountedUsdt,
    feeDnz: useDnz ? feeDnz : 0,
    usdtCharge: useDnz ? 0 : feeUsdt,
  }
}
