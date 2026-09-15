import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  calculatePnl,
  capQuantityByBalance,
  positionSize,
  type OrderInput,
} from '@/engine/calculations'
import { getSessionUserId, WALLET_STORAGE_KEY } from '@/services/authService'
import { claimPromoRemote, getMoneyRestrictions, pushBalanceToServer, recordTransaction } from '@/services/supabaseWallet'
import { roundTo } from '@/lib/utils'
import type { OrderSide, Position, TradingMode } from '@/types'

export interface TradeRecord {
  id: string
  symbol: string
  side: OrderSide
  mode: TradingMode
  quantity: number
  entryPrice: number
  exitPrice: number
  leverage: number
  pnl: number
  reason: 'manual' | 'liquidation' | 'tp_sl' | 'reduce'
  closedAt: number
}

export interface DepositRecord {
  id: string
  amount: number
  at: number
  /** Where the funds came from — card deposit, promo code, or referral. */
  source: 'card' | 'promo' | 'referral'
}

export interface WithdrawalRecord {
  id: string
  amount: number
  at: number
}

export type OpenPositionResult =
  | { ok: true; position: Position }
  | { ok: false; error: string }

export type RedeemPromoResult =
  | { ok: true; amount: number }
  | { ok: false; error: string }

export type TradeActionResult = { ok: true } | { ok: false; error: string }

/** A fill may originate from spot (`buy`/`sell`) or futures (`long`/`short`). */
export type FillNowInput = Omit<OrderInput, 'side' | 'leverage'> & {
  side: OrderSide | 'buy' | 'sell'
  leverage?: number
  reduceOnly?: boolean
}

export interface SpotTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  at: number
}

/**
 * A spot lot bought with take-profit / stop-loss attached (Oto-Limit/Oto-Stop).
 * The coin itself lives in `spotBalances`; the position exists purely to give
 * the TP/SL watchdog something to close against.
 */
export interface SpotPosition {
  id: string
  symbol: string
  quantity: number
  entryPrice: number
  tpPrice?: number | null
  slPrice?: number | null
  openedAt: number
}

/** Base coin of a pair, e.g. BTCUSDT -> BTC. */
function coinOf(symbol: string): string {
  return symbol.replace(/USDT$/i, '').toUpperCase()
}

/** Light rounding so tiny float artifacts don't accumulate in balances. */
function roundQty(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

/** Promo codes that add a bonus once per account. */
export const PROMO_CODES: Record<string, number> = {
  dnztrd100: 100,
  deniz100: 100,
}

let idCounter = 0
function makeId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/**
 * Session-scoped storage: every user's wallet lives under its own key, so
 * logging in as a different user loads their own balance/positions/history.
 * Writes are ignored while no session is active (e.g. during logout reset).
 */
function createWalletStorage() {
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

interface TradeState {
  balance: number
  positions: Position[]
  trades: TradeRecord[]
  deposits: DepositRecord[]
  withdrawals: WithdrawalRecord[]
  promos: string[]
  spotBalances: Record<string, number>
  spotTrades: SpotTrade[]
  spotPositions: SpotPosition[]

  deposit: (amount: number, source?: DepositRecord['source']) => void
  withdraw: (amount: number) => void
  openPosition: (input: OrderInput) => OpenPositionResult
  closePosition: (id: string, marketPrice: number, reason?: 'manual' | 'liquidation' | 'tp_sl' | 'reduce') => void
  closeSpotPosition: (id: string, marketPrice: number) => void
  forceLiquidate: (id: string, liquidationPrice: number) => void
  fillNow: (input: FillNowInput) => TradeActionResult
  redeemPromo: (code: string) => RedeemPromoResult
  /**
   * Supabase korumalı promosyon kullanımı: önce hesap bazında hak
   * `claim_promo` ile işaretlenir, sonra yerel bakiye işlenir. Başka
   * cihazda kullanılmışsa bakiye İŞLENMEZ. Supabase yoksa (test/offline)
   * yerel mantığa düşer.
   */
  redeemPromoAsync: (code: string) => Promise<RedeemPromoResult>
  /**
   * Uzakta (başka cihazda) kullanılmış kodları bakiye işlemeden yerel
   * listeyle birleştirir — giriş sonrası senkron için.
   */
  syncPromos: (codes: string[]) => void
  spotBuy: (input: { symbol: string; quantity: number; price: number }) => TradeActionResult
  spotSell: (input: { symbol: string; quantity: number; price: number }) => TradeActionResult
  setBalance: (value: number) => void
  resetWallet: () => void
}

const initialState = {
  balance: 0,
  positions: [],
  trades: [],
  deposits: [],
  withdrawals: [],
  promos: [],
  spotBalances: {},
  spotTrades: [],
  spotPositions: [],
}

export const useTradeStore = create<TradeState>()(
  persist(
    (set, get) => ({
      ...initialState,

      deposit: (amount, source = 'card') => {
        if (!Number.isFinite(amount) || amount <= 0) return
        const usdt = roundTo(amount)
        set((state) => ({
          balance: roundTo(state.balance + usdt),
          deposits: [
            ...state.deposits,
            { id: makeId('dep'), amount: usdt, at: Date.now(), source },
          ],
        }))
      },

      withdraw: (amount) => {
        if (!Number.isFinite(amount) || amount <= 0) return
        const usdt = roundTo(amount)
        set((state) => ({
          balance: Math.max(0, roundTo(state.balance - usdt)),
          withdrawals: [
            ...state.withdrawals,
            { id: makeId('wdr'), amount: usdt, at: Date.now() },
          ],
        }))
      },

      openPosition: (input) => {
        const { balance, positions } = get()
        if (positionSize(balance, input).quantity === 0 && input.quantity > 0) {
          return { ok: false, error: 'Insufficient balance for this order size.' }
        }
        const quantity = capQuantityByBalance(
          input.quantity,
          balance,
          input.entryPrice,
          input.mode === 'futures' ? input.leverage : 1,
        )
        if (quantity <= 0) {
          return { ok: false, error: 'Amount must be greater than zero.' }
        }

        const marginNeeded = positionSize(balance, {
          ...input,
          quantity,
        }).margin

        const position: Position = {
          id: makeId('pos'),
          symbol: input.symbol,
          side: input.side,
          entryPrice: input.entryPrice,
          quantity,
          leverage: input.mode === 'futures' ? input.leverage : 1,
          mode: input.mode,
          openedAt: Date.now(),
          ...(input.tpPrice ? { tpPrice: input.tpPrice } : {}),
          ...(input.slPrice ? { slPrice: input.slPrice } : {}),
          ...(input.triggerType ? { triggerType: input.triggerType } : {}),
          ...(input.reduceOnly ? { reduceOnly: input.reduceOnly } : {}),
        }

        set(() => ({
          balance: Math.max(0, roundTo(balance - marginNeeded)),
          positions: [...positions, position],
        }))
        // Marjin kilidi sunucuya da yansır (giriş senkronu tutarlı kalır).
        void pushBalanceToServer(getSessionUserId() ?? '', get().balance)
        return { ok: true, position }
      },

      closePosition: (id, marketPrice, reason = 'manual') => {
        const { positions, balance } = get()
        const position = positions.find((p) => p.id === id)
        if (!position) return

        const pnl = calculatePnl(position, marketPrice)
        const entryNotional = position.entryPrice * position.quantity
        const margin = position.mode === 'futures'
          ? entryNotional / position.leverage
          : entryNotional

        const record: TradeRecord = {
          id: makeId('trade'),
          symbol: position.symbol,
          side: position.side,
          mode: position.mode,
          quantity: position.quantity,
          entryPrice: position.entryPrice,
          exitPrice: marketPrice,
          leverage: position.leverage,
          pnl,
          reason,
          closedAt: Date.now(),
        }

        set(() => ({
          balance: Math.max(0, roundTo(balance + margin + pnl)),
          positions: positions.filter((p) => p.id !== id),
          trades: [record, ...get().trades].slice(0, 200),
        }))
        // Kapanış kâr/zararı sunucuya da yazılır (oturum kârı korunur).
        void pushBalanceToServer(getSessionUserId() ?? '', get().balance)

        void recordTransaction({
          userId: getSessionUserId() ?? '',
          type: position.side === 'long' ? 'trade_buy' : 'trade_sell',
          symbol: position.symbol,
          side: position.side === 'long' ? 'buy' : 'sell',
          quantity: position.quantity,
          price: marketPrice,
          amountUsdt: marketPrice * position.quantity,
        })
      },

      forceLiquidate: (id, liquidationPrice) => {
        get().closePosition(id, liquidationPrice, 'liquidation')
        set({ balance: 0 })
        void pushBalanceToServer(getSessionUserId() ?? '', 0)
      },

      closeSpotPosition: (id, marketPrice) => {
        const pos = get().spotPositions.find((p) => p.id === id)
        if (!pos) return
        const coin = coinOf(pos.symbol)
        const held = get().spotBalances[coin] ?? 0
        const qty = roundQty(Math.min(pos.quantity, held))
        if (qty <= 0) {
          set((s) => ({ spotPositions: s.spotPositions.filter((p) => p.id !== id) }))
          return
        }
        const proceeds = roundQty(qty * marketPrice)
        const trade: SpotTrade = {
          id: makeId('spt'),
          symbol: pos.symbol,
          side: 'sell',
          quantity: qty,
          price: marketPrice,
          at: Date.now(),
        }
        set((s) => ({
          spotPositions: s.spotPositions.filter((p) => p.id !== id),
          spotBalances: {
            ...s.spotBalances,
            [coin]: roundQty(Math.max(0, held - qty)),
          },
          balance: roundTo(s.balance + proceeds),
          spotTrades: [trade, ...s.spotTrades].slice(0, 200),
        }))
        void pushBalanceToServer(getSessionUserId() ?? '', get().balance)
      },

      fillNow: (input) => {
        const {
          symbol, side, quantity, entryPrice, leverage = 1, mode,
          tpPrice, slPrice, triggerType, reduceOnly, tif,
        } = input
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
          return { ok: false, error: 'Geçersiz emir miktarı.' }
        }
        const buy = side === 'buy' || side === 'long'

        if (mode === 'spot') {
          if (tif === 'FOK') {
            if (buy ? quantity * entryPrice > get().balance : quantity > (get().spotBalances[coinOf(symbol)] ?? 0)) {
              return { ok: false, error: 'FOK: tam miktar karşılanamıyor.' }
            }
          } else if (tif === 'IOC') {
            let qty = quantity
            if (buy) qty = Math.min(quantity, get().balance / entryPrice)
            else qty = Math.min(quantity, get().spotBalances[coinOf(symbol)] ?? 0)
            if (qty <= 0) return { ok: false, error: 'IOC: karşılanacak miktar yok.' }
            return buy
              ? get().spotBuy({ symbol, quantity: qty, price: entryPrice })
              : get().spotSell({ symbol, quantity: qty, price: entryPrice })
          }
          const res = buy
            ? get().spotBuy({ symbol, quantity, price: entryPrice })
            : get().spotSell({ symbol, quantity, price: entryPrice })
          // Oto-Limit/Oto-Stop for spot: a buy with TP/SL attaches them to the
          // freshly purchased lot so the watchdog can auto-close it later.
          if (res.ok && buy && (tpPrice || slPrice)) {
            set((s) => ({
              spotPositions: [
                ...s.spotPositions,
                {
                  id: makeId('spp'),
                  symbol,
                  quantity: roundQty(quantity),
                  entryPrice,
                  tpPrice: tpPrice || null,
                  slPrice: slPrice || null,
                  openedAt: Date.now(),
                },
              ],
            }))
          }
          return res
        }

        if (reduceOnly) {
          const pos = get().positions.find(
            (p) => p.symbol === symbol && p.mode === 'futures' && p.side !== side,
          )
          if (!pos) return { ok: false, error: 'Azaltılacak pozisyon bulunamadı.' }
          if (quantity >= pos.quantity) {
            get().closePosition(pos.id, entryPrice, 'reduce')
            return { ok: true }
          }
          const q = Math.min(quantity, pos.quantity)
          const pnl = calculatePnl(pos, entryPrice) * (q / pos.quantity)
          const releasedMargin = pos.entryPrice * q / pos.leverage
          const prevBalance = get().balance
          set((s) => ({
            balance: roundTo(Math.max(0, prevBalance + pnl + releasedMargin)),
            positions: s.positions.map((p) =>
              p.id === pos.id
                ? { ...p, quantity: roundTo(p.quantity - q, 4) }
                : p,
            ),
          }))
          void pushBalanceToServer(getSessionUserId() ?? '', get().balance)
          return { ok: true }
        }

        const lev = mode === 'futures' ? leverage : 1
        if (tif === 'FOK' && capQuantityByBalance(quantity, get().balance, entryPrice, lev) < quantity) {
          return { ok: false, error: 'FOK: tam miktar karşılanamıyor.' }
        }
        let qty = quantity
        if (tif === 'IOC') {
          const mx = capQuantityByBalance(quantity, get().balance, entryPrice, lev)
          if (mx < quantity) {
            qty = Math.max(0, mx)
            if (qty <= 0) return { ok: false, error: 'IOC: karşılanacak miktar yok.' }
          }
        }
        const res = get().openPosition({
          symbol, side: side as OrderSide, mode: 'futures', quantity: qty, entryPrice, leverage: lev,
        })
        if (!res.ok) return res
        if (tpPrice || slPrice) {
          const pid = res.position.id
          set((s) => ({
            positions: s.positions.map((p) =>
              p.id === pid
                ? {
                    ...p,
                    tpPrice: tpPrice || null,
                    slPrice: slPrice || null,
                    triggerType: triggerType || 'last',
                  }
                : p,
            ),
          }))
        }
        return { ok: true }
      },

      redeemPromo: (rawCode) => {
        const code = rawCode.trim().toLowerCase()
        const amount = PROMO_CODES[code]
        if (!amount) {
          return { ok: false, error: 'Geçersiz promosyon kodu.' }
        }
        if (get().promos.includes(code)) {
          return { ok: false, error: 'Bu promosyon kodu daha önce kullanıldı.' }
        }
        set((state) => ({
          promos: [...state.promos, code],
          balance: roundTo(state.balance + amount),
          deposits: [
            ...state.deposits,
            { id: makeId('dep'), amount, at: Date.now(), source: 'promo' },
          ],
        }))
        return { ok: true, amount }
      },

      redeemPromoAsync: async (rawCode) => {
        const code = rawCode.trim().toLowerCase()
        const amount = PROMO_CODES[code]
        if (!amount) {
          return { ok: false, error: 'Geçersiz promosyon kodu.' }
        }
        if (get().promos.includes(code)) {
          return { ok: false, error: 'Bu promosyon kodu daha önce kullanıldı.' }
        }
        const userId = getSessionUserId()
        // Admin kısıtı: para yatırması kapatılan hesap promosyonla da
        // bakiye yükleyemez (çevrimdışı/test modunda kısıt bilinemez).
        // getMoneyRestrictions hata durumunda kısıtsız döner (fail-open).
        if (userId && (await getMoneyRestrictions(userId)).depositBlocked) {
          return { ok: false, error: 'Para yatırma işlemin yönetici tarafından kısıtlanmış. Destek ile iletişime geç.' }
        }
        if (userId) {
          const claim = await claimPromoRemote(userId, code)
          if (claim === 'already') {
            // Başka cihazda kullanılmış: bakiye işlemeden listeyi işaretle.
            get().syncPromos([code])
            return { ok: false, error: 'Bu promosyon kodu daha önce kullanıldı.' }
          }
          if (claim === 'error') {
            return { ok: false, error: 'Bağlantı kurulamadı. Lütfen tekrar deneyin.' }
          }
          // 'claimed' | 'offline' → yerel bakiye işlemeye devam et.
        }
        return get().redeemPromo(rawCode)
      },

      syncPromos: (codes) => {
        const clean = codes
          .map((c) => c.trim().toLowerCase())
          .filter((c) => c && PROMO_CODES[c])
        if (clean.length === 0) return
        set((state) => ({
          promos: Array.from(new Set([...state.promos, ...clean])),
        }))
      },

      spotBuy: (input) => {
        const { symbol, quantity, price } = input
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
          return { ok: false, error: 'Amount must be greater than zero.' }
        }
        const cost = roundQty(quantity * price)
        const { balance, spotBalances, spotTrades } = get()
        const coin = coinOf(symbol)
        if (cost > balance) {
          return { ok: false, error: 'Insufficient USDT balance.' }
        }
        const trade: SpotTrade = {
          id: makeId('spt'),
          symbol,
          side: 'buy',
          quantity: roundQty(quantity),
          price,
          at: Date.now(),
        }
        set({
          balance: Math.max(0, roundTo(balance - cost)),
          spotBalances: {
            ...spotBalances,
            [coin]: roundQty((spotBalances[coin] ?? 0) + roundQty(quantity)),
          },
          spotTrades: [trade, ...spotTrades].slice(0, 200),
        })
        void pushBalanceToServer(getSessionUserId() ?? '', get().balance)
        void recordTransaction({
          userId: getSessionUserId() ?? '',
          type: 'trade_buy',
          symbol,
          side: 'buy',
          quantity: roundQty(quantity),
          price,
          amountUsdt: cost,
        })
        return { ok: true }
      },

      spotSell: (input) => {
        const { symbol, quantity, price } = input
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
          return { ok: false, error: 'Amount must be greater than zero.' }
        }
        const proceeds = roundQty(quantity * price)
        const { balance, spotBalances, spotTrades } = get()
        const coin = coinOf(symbol)
        const held = spotBalances[coin] ?? 0
        if (quantity > held) {
          return { ok: false, error: `Insufficient ${coin} balance.` }
        }
        const trade: SpotTrade = {
          id: makeId('spt'),
          symbol,
          side: 'sell',
          quantity: roundQty(quantity),
          price,
          at: Date.now(),
        }
        set({
          balance: roundTo(balance + proceeds),
          spotBalances: {
            ...spotBalances,
            [coin]: roundQty(held - quantity),
          },
          spotTrades: [trade, ...spotTrades].slice(0, 200),
        })
        void pushBalanceToServer(getSessionUserId() ?? '', get().balance)
        void recordTransaction({
          userId: getSessionUserId() ?? '',
          type: 'trade_sell',
          symbol,
          side: 'sell',
          quantity: roundQty(quantity),
          price,
          amountUsdt: proceeds,
        })
        return { ok: true }
      },

      setBalance: (value) => {
        if (!Number.isFinite(value) || value < 0) return
        set({ balance: roundTo(value) })
      },

      resetWallet: () => set({ ...initialState }),
    }),
    {
      name: WALLET_STORAGE_KEY,
      storage: createJSONStorage(() => createWalletStorage()),
    },
  ),
)