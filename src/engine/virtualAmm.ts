/**
 * Sanal Piyasa AMM matematiği (x * y = k, sabit çarpım).
 *
 * Supabase RPC `execute_virtual_trade` ile BİREBİR aynı formüller —
 * çevrimdışı/yerel modda aynı motor çalışır, sonuçlar tutarlıdır.
 * Ücret: giren tutarın %0.3'ü havuza girmez (fiyata yansımaz).
 * NOT: oto motor (`executeAutoPoolTradeLocal` + sunucu oto RPC/cron)
 * satış bacağını net tutarla (`a·(1-f)`) oynar ki 50/50 rastgele akış
 * havuzu tek yöne kaydırmasın — buradaki kotasyonlar kullanıcı/manuel
 * hamleler içindir, değiştirilmedi.
 */

export const VIRTUAL_AMM_FEE_RATE = 0.003

export interface VirtualPool {
  symbol: string
  reserveUsdt: number
  reserveToken: number
}

export interface VirtualQuote {
  /** Alışta çıkan token / satışta çıkan USDT. */
  amountOut: number
  /** USDT bacağı (alışta yatırılan, satışta çıkan). */
  usdtAmount: number
  /** Token bacağı (alışta çıkan, satışta yatırılan). */
  tokenAmount: number
  newReserveUsdt: number
  newReserveToken: number
  oldPrice: number
  newPrice: number
  priceImpactPct: number
}

function base(pool: VirtualPool): { k: number; oldPrice: number } {
  return { k: pool.reserveUsdt * pool.reserveToken, oldPrice: pool.reserveUsdt / pool.reserveToken }
}

/** Alış kotasyonu: usdtIn USDT karşılığı kaç token çıkar? */
export function quoteVirtualBuy(pool: VirtualPool, usdtIn: number): VirtualQuote {
  if (!(usdtIn > 0)) throw new Error('Geçersiz tutar.')
  const { k, oldPrice } = base(pool)
  const inAfterFee = usdtIn * (1 - VIRTUAL_AMM_FEE_RATE)
  const newReserveUsdt = pool.reserveUsdt + inAfterFee
  const tokenOut = pool.reserveToken - k / newReserveUsdt
  if (!(tokenOut > 0) || tokenOut >= pool.reserveToken) {
    throw new Error('Havuz derinliği yetersiz.')
  }
  const newReserveToken = pool.reserveToken - tokenOut
  const newPrice = newReserveUsdt / newReserveToken
  return {
    amountOut: tokenOut,
    usdtAmount: usdtIn,
    tokenAmount: tokenOut,
    newReserveUsdt,
    newReserveToken,
    oldPrice,
    newPrice,
    priceImpactPct: ((newPrice - oldPrice) / oldPrice) * 100,
  }
}

/** Satış kotasyonu: tokenIn token karşılığı kaç USDT çıkar? */
export function quoteVirtualSell(pool: VirtualPool, tokenIn: number): VirtualQuote {
  if (!(tokenIn > 0)) throw new Error('Geçersiz tutar.')
  const { k, oldPrice } = base(pool)
  const inAfterFee = tokenIn * (1 - VIRTUAL_AMM_FEE_RATE)
  const newReserveToken = pool.reserveToken + inAfterFee
  const usdtOut = pool.reserveUsdt - k / newReserveToken
  if (!(usdtOut > 0) || usdtOut >= pool.reserveUsdt) {
    throw new Error('Havuz derinliği yetersiz.')
  }
  const newReserveUsdt = pool.reserveUsdt - usdtOut
  const newPrice = newReserveUsdt / newReserveToken
  return {
    amountOut: usdtOut,
    usdtAmount: usdtOut,
    tokenAmount: tokenIn,
    newReserveUsdt,
    newReserveToken,
    oldPrice,
    newPrice,
    priceImpactPct: ((newPrice - oldPrice) / oldPrice) * 100,
  }
}

/** Seed fiyatları (rezerv oranları): RPC seed'i ile aynı olmalı. */
export function seedPrice(reserveUsdt: number, reserveToken: number): number {
  return reserveUsdt / reserveToken
}

/**
 * Bot satışı (USDT cinsinden hedef): havuzdan `usdtOut` çıkarmak için
 * gereken token girişi tersine çözülür. Bakiye dokunulmaz — sistem likiditesi.
 */
export function quoteVirtualSellForUsdt(pool: VirtualPool, usdtOut: number): VirtualQuote {
  if (!(usdtOut > 0)) throw new Error('Geçersiz tutar.')
  if (usdtOut >= pool.reserveUsdt) throw new Error('Havuz derinliği yetersiz.')
  const { k, oldPrice } = base(pool)
  const tokenIn = (k / (pool.reserveUsdt - usdtOut) - pool.reserveToken) / (1 - VIRTUAL_AMM_FEE_RATE)
  if (!(tokenIn > 0)) throw new Error('Havuz derinliği yetersiz.')
  const inAfterFee = tokenIn * (1 - VIRTUAL_AMM_FEE_RATE)
  const newReserveToken = pool.reserveToken + inAfterFee
  const newReserveUsdt = pool.reserveUsdt - usdtOut
  const newPrice = newReserveUsdt / newReserveToken
  return {
    amountOut: usdtOut,
    usdtAmount: usdtOut,
    tokenAmount: tokenIn,
    newReserveUsdt,
    newReserveToken,
    oldPrice,
    newPrice,
    priceImpactPct: ((newPrice - oldPrice) / oldPrice) * 100,
  }
}
