import { useCallback } from 'react'
import { useDnzStore } from '@/store/dnzStore'
import { useTradeStore } from '@/store/tradeStore'
import { getSessionUserId } from '@/services/authService'
import { pushBalanceToServer, recordTransaction } from '@/services/supabaseWallet'
import { DNZ_PAIR } from '@/services/dnzService'
import { formatNumber } from '@/lib/utils'

/**
 * DNZ alım-satım orkestrasyonu (tek kod yolu — cüzdan ekranı ve işlem
 * ekranındaki DNZ paneli burayı kullanır).
 *
 * - Fiyat her işlemde `tick()` ile tazelenir (simüle yürüyüş).
 * - DNZ bacağı `dnzStore`, USDT bacağı `tradeStore` üzerinden işler;
 *   USDT tarafı `profiles.balance` + `transactions` defterine yansır.
 * - DNZ takasında komisyon YOKTUR (ücret tokenının kendisi).
 */

export interface DnzTradeResult {
  ok: boolean
  message: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function useDnzTrade() {
  const buyForUsdt = useCallback((usdt: number): DnzTradeResult => {
    if (!Number.isFinite(usdt) || usdt <= 0) {
      return { ok: false, message: 'Geçerli bir USDT tutarı gir.' }
    }
    const dnz = useDnzStore.getState()
    dnz.tick()
    const price = dnz.price
    if (!(price > 0)) return { ok: false, message: 'DNZ fiyatı alınamadı. Lütfen tekrar dene.' }
    const qty = usdt / price
    const trade = useTradeStore.getState()
    if (usdt > trade.balance) return { ok: false, message: 'Yetersiz USDT bakiyesi.' }
    const res = dnz.buyDnz({ qty, price, usdtCost: usdt })
    if (!res.ok) return { ok: false, message: res.error }
    trade.setBalance(Math.max(0, round2(trade.balance - usdt)))
    const userId = getSessionUserId() ?? ''
    void pushBalanceToServer(userId, useTradeStore.getState().balance)
    void recordTransaction({
      userId,
      type: 'trade_buy',
      symbol: DNZ_PAIR,
      side: 'buy',
      quantity: qty,
      price,
      amountUsdt: usdt,
    })
    return { ok: true, message: `${formatNumber(qty, 4)} DNZ alındı.` }
  }, [])

  const sellQty = useCallback((qty: number): DnzTradeResult => {
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, message: 'Geçerli bir DNZ miktarı gir.' }
    }
    const dnz = useDnzStore.getState()
    dnz.tick()
    const price = dnz.price
    if (!(price > 0)) return { ok: false, message: 'DNZ fiyatı alınamadı. Lütfen tekrar dene.' }
    const res = dnz.sellDnz({ qty, price })
    if (!res.ok) return { ok: false, message: res.error }
    const trade = useTradeStore.getState()
    trade.setBalance(round2(trade.balance + res.proceeds))
    const userId = getSessionUserId() ?? ''
    void pushBalanceToServer(userId, useTradeStore.getState().balance)
    void recordTransaction({
      userId,
      type: 'trade_sell',
      symbol: DNZ_PAIR,
      side: 'sell',
      quantity: qty,
      price,
      amountUsdt: res.proceeds,
    })
    return { ok: true, message: `${formatNumber(res.proceeds, 2)} USDT alındı.` }
  }, [])

  return { buyForUsdt, sellQty }
}
