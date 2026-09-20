import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getSessionUserId } from '@/services/authService'
import {
  DNZ_SEED_PRICE,
  DNZ_SYMBOL,
  fetchDnzLedgerRemote,
  getDnzBalanceRemote,
  pushDnzBalanceRemote,
  recordDnzLedgerRemote,
  type DnzLedgerType,
  type DnzRemoteEntry,
} from '@/services/dnzService'
import { listVirtualCoins } from '@/services/virtualMarketService'
import { roundFee } from '@/engine/fees'

/**
 * DNZ borsa tokenı cüzdanı (oturum bazlı persist).
 *
 * - Bakiye/ortalama maliyet/komisyon tercihi hesap başına saklanır
 *   (anahtar `deniztradx_dnz_<uid>`, cüzdan deseniyle aynı).
 * - Fiyat TEK kaynaktan gelir: AMM havuzu (`syncPriceFromPool` /
 *   `refreshRemote` ile tazelenir; takas sonrası gerçekleşen fiyata
 *   çekilir). Ayrı simüle fiyat yoktur.
 * - Uzak senkron best-effort: bakiye + defter Supabase'e itilir,
 *   açılışta uzaktan tazelenir; çevrimdışı yerelde çalışır.
 * - USDT bacağına takas yerleşimi DOKUNMAZ (döngüsel import yok):
 *   havuz takasları `virtualMarketService`, cüzdan takası `useDnzTrade`
 *   üzerinden yürür; bu store yalnızca DNZ tarafını işler.
 */

export interface DnzLedgerEntry {
  id: string
  type: DnzLedgerType
  amountDnz: number
  priceUsdt: number | null
  amountUsdt: number | null
  balanceAfter: number | null
  at: number
}

export const DNZ_STORAGE_KEY = 'deniztradx_dnz'

function createDnzStorage() {
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

let idCounter = 0
function makeId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function toEntry(e: DnzRemoteEntry): DnzLedgerEntry {
  return {
    id: e.id,
    type: e.type,
    amountDnz: e.amountDnz,
    priceUsdt: e.priceUsdt,
    amountUsdt: e.amountUsdt,
    balanceAfter: e.balanceAfter,
    at: e.at,
  }
}

interface DnzState {
  balance: number
  avgCost: number
  price: number
  payWithDnz: boolean
  ledger: DnzLedgerEntry[]
  /** Havuz fiyatını çeker (komisyon değerlemesi + cüzdan görünümü için). */
  syncPriceFromPool: () => Promise<void>
  setPayWithDnz: (value: boolean) => void
  /**
   * DNZ alış (USDT takası): DNZ tarafını işler, USDT düşüşünü çağıran
   * yapar. `usdtCost` bilgilendirme + defter içindir.
   */
  buyDnz: (input: { qty: number; price: number; usdtCost: number }) => { ok: true } | { ok: false; error: string }
  /** DNZ satış: DNZ tarafını düşer, USDT karşılığını döndürür. */
  sellDnz: (input: { qty: number; price: number }) => { ok: true; proceeds: number } | { ok: false; error: string }
  /**
   * Komisyon kesintisi (indirimli DNZ tutar): bakiye yetiyorsa düşer ve
   * deftere `fee_discount` işler. Yetmezse `false` döner (arayan USDT
   * komisyonuna düşer) — işlem durmaz.
   */
  deductFeeDnz: (qty: number, meta?: Record<string, unknown>) => boolean
  /** Transfer çıkışı (uzak RPC sonrası yerel eşitleme / yerel mod). */
  applyTransferOut: (qty: number, counterparty: string) => void
  /** Transfer girişi (yerel mod alıcı tarafı). */
  applyTransferIn: (qty: number, counterparty: string) => void
  /** Uzaktan bakiye + defter tazeler (varsa; yoksa yereli korur). */
  refreshRemote: () => Promise<void>
  resetDnz: () => void
}

const initialState = {
  balance: 0,
  avgCost: 0,
  price: DNZ_SEED_PRICE,
  payWithDnz: false,
  ledger: [] as DnzLedgerEntry[],
}

export const useDnzStore = create<DnzState>()(
  persist(
    (set, get) => ({
      ...initialState,

      syncPriceFromPool: async () => {
        try {
          const list = await listVirtualCoins()
          const row = list.find((c) => c.symbol === DNZ_SYMBOL)
          if (row && row.price > 0) set({ price: row.price })
        } catch {
          // yoksay — önbellek fiyat korunur
        }
      },

      setPayWithDnz: (value) => set({ payWithDnz: value }),

      buyDnz: ({ qty, price, usdtCost }) => {
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
          return { ok: false, error: 'Geçerli bir tutar gir.' }
        }
        const q = roundFee(qty)
        const userId = getSessionUserId() ?? ''
        const prevQty = get().balance
        const prevAvg = get().avgCost
        const nextQty = roundFee(prevQty + q)
        const nextAvg = prevQty > 0 ? (prevQty * prevAvg + q * price) / (prevQty + q) : price
        const entry: DnzLedgerEntry = {
          id: makeId('dnz'),
          type: 'buy',
          amountDnz: q,
          priceUsdt: price,
          amountUsdt: roundFee(usdtCost),
          balanceAfter: nextQty,
          at: Date.now(),
        }
        set((s) => ({ balance: nextQty, avgCost: nextAvg, ledger: [entry, ...s.ledger].slice(0, 100) }))
        void pushDnzBalanceRemote(userId, nextQty)
        void recordDnzLedgerRemote(userId, {
          type: 'buy',
          amountDnz: q,
          priceUsdt: price,
          amountUsdt: roundFee(usdtCost),
          balanceAfter: nextQty,
        })
        return { ok: true }
      },

      sellDnz: ({ qty, price }) => {
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
          return { ok: false, error: 'Geçerli bir tutar gir.' }
        }
        const q = roundFee(qty)
        const held = get().balance
        if (q > held) return { ok: false, error: 'Yetersiz DNZ bakiyesi.' }
        const proceeds = roundFee(q * price)
        const nextQty = roundFee(Math.max(0, held - q))
        const userId = getSessionUserId() ?? ''
        const entry: DnzLedgerEntry = {
          id: makeId('dnz'),
          type: 'sell',
          amountDnz: q,
          priceUsdt: price,
          amountUsdt: proceeds,
          balanceAfter: nextQty,
          at: Date.now(),
        }
        set((s) => ({
          balance: nextQty,
          avgCost: nextQty <= 0 ? 0 : s.avgCost,
          ledger: [entry, ...s.ledger].slice(0, 100),
        }))
        void pushDnzBalanceRemote(userId, nextQty)
        void recordDnzLedgerRemote(userId, {
          type: 'sell',
          amountDnz: q,
          priceUsdt: price,
          amountUsdt: proceeds,
          balanceAfter: nextQty,
        })
        return { ok: true, proceeds }
      },

      deductFeeDnz: (qty, meta) => {
        const q = roundFee(qty)
        if (!Number.isFinite(q) || q <= 0) return false
        const held = get().balance
        if (q > held) return false
        const nextQty = roundFee(Math.max(0, held - q))
        const userId = getSessionUserId() ?? ''
        const entry: DnzLedgerEntry = {
          id: makeId('dnz'),
          type: 'fee_discount',
          amountDnz: q,
          priceUsdt: get().price,
          amountUsdt: null,
          balanceAfter: nextQty,
          at: Date.now(),
        }
        set((s) => ({ balance: nextQty, ledger: [entry, ...s.ledger].slice(0, 100) }))
        void pushDnzBalanceRemote(userId, nextQty)
        void recordDnzLedgerRemote(userId, {
          type: 'fee_discount',
          amountDnz: q,
          priceUsdt: get().price,
          balanceAfter: nextQty,
          meta,
        })
        return true
      },

      applyTransferOut: (qty, counterparty) => {
        const q = roundFee(qty)
        if (!Number.isFinite(q) || q <= 0) return
        const userId = getSessionUserId() ?? ''
        const nextQty = roundFee(Math.max(0, get().balance - q))
        const entry: DnzLedgerEntry = {
          id: makeId('dnz'),
          type: 'transfer_out',
          amountDnz: q,
          priceUsdt: null,
          amountUsdt: null,
          balanceAfter: nextQty,
          at: Date.now(),
        }
        set((s) => ({ balance: nextQty, ledger: [entry, ...s.ledger].slice(0, 100) }))
        void pushDnzBalanceRemote(userId, nextQty)
        void recordDnzLedgerRemote(userId, { type: 'transfer_out', amountDnz: q, balanceAfter: nextQty, meta: { counterparty } })
      },

      applyTransferIn: (qty, counterparty) => {
        const q = roundFee(qty)
        if (!Number.isFinite(q) || q <= 0) return
        const userId = getSessionUserId() ?? ''
        const nextQty = roundFee(get().balance + q)
        const entry: DnzLedgerEntry = {
          id: makeId('dnz'),
          type: 'transfer_in',
          amountDnz: q,
          priceUsdt: null,
          amountUsdt: null,
          balanceAfter: nextQty,
          at: Date.now(),
        }
        set((s) => ({ balance: nextQty, ledger: [entry, ...s.ledger].slice(0, 100) }))
        void pushDnzBalanceRemote(userId, nextQty)
        void recordDnzLedgerRemote(userId, { type: 'transfer_in', amountDnz: q, balanceAfter: nextQty, meta: { counterparty } })
      },

      refreshRemote: async () => {
        const userId = getSessionUserId()
        await get().syncPriceFromPool()
        if (!userId) return
        const [remoteBalance, remoteLedger] = await Promise.all([
          getDnzBalanceRemote(userId),
          fetchDnzLedgerRemote(userId, 20),
        ])
        // Satır yoksa (yeni hesap) yerel korunur; varsa uzak doğruluk kaynağıdır.
        if (remoteLedger !== null) {
          set((s) => ({
            balance: remoteBalance ?? s.balance,
            ledger: remoteLedger.map(toEntry),
          }))
        } else if (remoteBalance !== null) {
          set({ balance: remoteBalance })
        }
      },

      resetDnz: () => set({ ...initialState }),
    }),
    {
      name: DNZ_STORAGE_KEY,
      storage: createJSONStorage(() => createDnzStorage()),
    },
  ),
)
