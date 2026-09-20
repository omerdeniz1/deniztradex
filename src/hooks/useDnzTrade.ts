import { useCallback } from 'react'
import { executeVirtualTrade } from '@/services/virtualMarketService'
import { DNZ_SYMBOL } from '@/services/dnzService'
import { formatNumber } from '@/lib/utils'

/**
 * DNZ alım-satım orkestrasyonu (tek kod yolu — cüzdan ekranındaki DNZ
 * kutuları burayı kullanır; işlem ekranı sanal panelden geçer).
 *
 * Takas HAVUZDA gerçekleşir (`executeVirtualTrade` DNZ dalı): fiyat
 * etkisi + rezerv hareketi + mum upsert aynen işler, DNZ bacağı dnz
 * defterine, USDT bacağı cüzdana yansır. DNZ takasında komisyon YOKTUR
 * (havuz ücreti %0.3 fiyatın içindedir).
 */

export interface DnzTradeResult {
  ok: boolean
  message: string
}

export function useDnzTrade() {
  const buyForUsdt = useCallback(async (usdt: number): Promise<DnzTradeResult> => {
    if (!Number.isFinite(usdt) || usdt <= 0) {
      return { ok: false, message: 'Geçerli bir USDT tutarı gir.' }
    }
    try {
      const res = await executeVirtualTrade(DNZ_SYMBOL, 'buy', usdt)
      return { ok: true, message: `${formatNumber(res.tokenAmount, 4)} DNZ alındı.` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'İşlem yapılamadı.' }
    }
  }, [])

  const sellQty = useCallback(async (qty: number): Promise<DnzTradeResult> => {
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, message: 'Geçerli bir DNZ miktarı gir.' }
    }
    try {
      const res = await executeVirtualTrade(DNZ_SYMBOL, 'sell', qty)
      return { ok: true, message: `${formatNumber(res.usdtAmount, 2)} USDT alındı.` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'İşlem yapılamadı.' }
    }
  }, [])

  return { buyForUsdt, sellQty }
}
