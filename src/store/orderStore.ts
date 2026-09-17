import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useTradeStore } from '@/store/tradeStore'
import { getSessionUserId } from '@/services/authService'
import type {
  MarginMode,
  OrderSide,
  OrderType,
  TradingMode,
  TriggerType,
  TIF,
} from '@/types'

export type OrderStance = OrderSide | 'buy' | 'sell'

export interface OrderSpec {
  id: string
  symbol: string
  mode: TradingMode
  side: OrderStance
  orderType: OrderType
  quantity: number
  entryPrice: number
  stopPrice?: number
  leverage: number
  tpPrice?: number | null
  slPrice?: number | null
  triggerType?: TriggerType
  marginMode?: MarginMode
  reduceOnly?: boolean
  postOnly?: boolean
  tif?: TIF
  cbRate?: number
  marketPrice?: number
  at: number
  leg?: 'limit' | 'stop'
  ocoId?: string | null
  peakPrice?: number
  filled?: boolean
}

export type PlaceResult =
  | { ok: true; pending?: boolean }
  | { ok: false; error: string }

let idCounter = 0
function makeId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/**
 * Oturum-kapsamlı depolama: bekleyen emirler kullanıcı başına saklanır
 * (cüzdan anahtarıyla aynı desen). Cihazlar arası taşıma sunucu
 * senkronunundur (`trading_state`); bu katman yeniden-yüklemeyi korur.
 */
const ORDERS_STORAGE_KEY = 'deniztradx_orders'

function createOrderStorage() {
  const uid = () => getSessionUserId()
  return {
    getItem: (name: string) => {
      const userId = uid()
      if (!userId) return null
      return localStorage.getItem(`${name}_${userId}`)
    },
    setItem: (name: string, value: string) => {
      const userId = uid()
      if (!userId) return
      localStorage.setItem(`${name}_${userId}`, value)
    },
    removeItem: (name: string) => {
      const userId = uid()
      if (!userId) return
      localStorage.removeItem(`${name}_${userId}`)
    },
  }
}

interface OrderState {
  pendingOrders: OrderSpec[]
  placeOrder: (input: Omit<OrderSpec, 'id' | 'at'>) => PlaceResult
  cancelPendingOrder: (id: string) => void
  fireOrder: (id: string, refPrice?: number) => PlaceResult
  /** Cihazlar arası senkron: sunucudaki bekleyen emirleri uygular. */
  hydrateOrders: (orders: OrderSpec[]) => void
  resetOrders: () => void
}

export const useOrderStore = create<OrderState>()(
  persist(
    (set, get) => ({
      pendingOrders: [],

      hydrateOrders: (orders) => set({ pendingOrders: [...orders] }),

      resetOrders: () => set({ pendingOrders: [] }),

  placeOrder: (n) => {
    const mk = n.marketPrice || 0
    const buy = n.side === 'buy' || n.side === 'long'
    const mkb = (P: number) => (buy ? P >= n.entryPrice : P <= n.entryPrice)

    if (n.orderType === 'market') {
      if (n.postOnly) {
        return { ok: false, error: 'Piyasa emri Post-Only ile kullanılamaz.' }
      }
      return useTradeStore
        .getState()
        .fillNow({ ...n, entryPrice: mk || n.entryPrice })
    }

    if (
      n.postOnly &&
      (n.orderType === 'limit' ||
        n.orderType === 'stop-limit' ||
        n.orderType === 'oco') &&
      mk > 0 &&
      mkb(mk)
    ) {
      return { ok: false, error: 'Post-Only: emir anında gerçekleşir.' }
    }

    if (n.orderType === 'limit') {
      if (mk > 0 && mkb(mk)) {
        return useTradeStore.getState().fillNow({
          ...n,
          entryPrice: buy ? Math.min(mk, n.entryPrice) : Math.max(mk, n.entryPrice),
        })
      }
      if (n.tif === 'IOC' || n.tif === 'FOK') {
        return { ok: false, error: 'Emir anında karşılanabilir değil.' }
      }
      const order: OrderSpec = { id: makeId('o'), at: Date.now(), ...n }
      set((s) => ({ pendingOrders: [...s.pendingOrders, order] }))
      return { ok: true, pending: true }
    }

    if (n.orderType === 'oco') {
      const leg: OrderSpec = {
        id: makeId('o'),
        at: Date.now(),
        ...n,
        leg: 'limit',
        ocoId: null,
        entryPrice: n.entryPrice,
      }
      const sib: OrderSpec = {
        id: makeId('o'),
        at: Date.now(),
        ...n,
        leg: 'stop',
        ocoId: leg.id,
        entryPrice: n.stopPrice || n.entryPrice,
      }
      leg.ocoId = leg.id
      set((s) => ({ pendingOrders: [...s.pendingOrders, leg, sib] }))
      return { ok: true, pending: true }
    }

    const order: OrderSpec = {
      id: makeId('o'),
      at: Date.now(),
      peakPrice: mk || n.entryPrice,
      ...n,
    }
    set((s) => ({ pendingOrders: [...s.pendingOrders, order] }))
    return { ok: true, pending: true }
  },

  cancelPendingOrder: (id) =>
    set((s) => {
      // OCO bacakları aynı ocoId'yi paylaşır: hangi bacak iptal edilirse
      // edilsin kardeş bacak da kalkar (yetim emir kalmaz).
      const target = s.pendingOrders.find((p) => p.id === id)
      const group = target?.ocoId ?? null
      return {
        pendingOrders: s.pendingOrders.filter(
          (p) => p.id !== id && p.ocoId !== id && !(group && (p.ocoId === group || p.id === group)),
        ),
      }
    }),

      fireOrder: (id, refPrice) => {
        const order = get().pendingOrders.find((p) => p.id === id)
        if (!order) return { ok: false, error: 'Emir bulunamadı.' }
        const remaining = get().pendingOrders.filter(
          (p) => p.id !== id && p.ocoId !== order.ocoId,
        )
        set({ pendingOrders: remaining })
        return useTradeStore
          .getState()
          .fillNow({ ...order, entryPrice: refPrice || order.entryPrice })
      },
    }),
    {
      name: ORDERS_STORAGE_KEY,
      storage: createJSONStorage(() => createOrderStorage()),
      // Yalnızca bekleyen emirler kalıcıdır; fonksiyonlar dışlanır.
      partialize: (s) => ({ pendingOrders: s.pendingOrders }),
    },
  ),
)