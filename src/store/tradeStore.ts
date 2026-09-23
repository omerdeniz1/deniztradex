import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  calculatePnl,
  capQuantityByBalance,
  positionLockedMargin,
  positionSize,
  type OrderInput,
} from '@/engine/calculations'
import { getSessionUserId, WALLET_STORAGE_KEY } from '@/services/authService'
import { claimPromoRemote, pushBalanceToServer, recordTransaction } from '@/services/supabaseWallet'
import { quoteSpotFee, SPOT_FEE_RATE, type FeeQuote } from '@/engine/fees'
import { useDnzStore } from '@/store/dnzStore'
import { clampFuturesLeverage } from '@/lib/virtualFutures'
import { roundTo } from '@/lib/utils'
import type { MarginMode, OrderSide, Position, TradingMode } from '@/types'

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
  marginMode?: MarginMode
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

/**
 * Bekleyen sanal limit emir (AMM): piyasa limit fiyata değince havuzda
 * gerçekleşir. `amount` alışta USDT, satışta token adedidir.
 */
export interface VirtualPendingOrder {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  amount: number
  limitPrice: number
  tpPrice?: number | null
  slPrice?: number | null
  at: number
}

/**
 * Sanal TP/SL lotu: AMM'den alınan miktara bağlı oto-satış.
 * Havuz fiyatı hedefe değince watchdog `executeVirtualTrade` ile satar.
 */
export interface VirtualTpSl {
  id: string
  symbol: string
  quantity: number
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

/**
 * Spot komisyon teklifi (%0.1, bkz. `engine/fees`): saf hesap, yan etki
 * YOK. DNZ fiyatı havuzdan önbelleklidir (`syncPriceFromPool` ile tazelenir).
 * DNZ ile ödeme aktif ve bakiye yetiyorsa teklifte `useDnz` true döner;
 * gerçek DNZ düşüşü `settleFeeDeduction` ile yapılır.
 */
function quoteFeeFor(notional: number): FeeQuote {
  const dnz = useDnzStore.getState()
  return quoteSpotFee(notional, {
    payWithDnz: dnz.payWithDnz,
    dnzBalance: dnz.balance,
    dnzPrice: dnz.price,
  })
}

/**
 * Teklifteki DNZ kesintisini uygular. DNZ düşülemezse (teklif sonrası
 * yarış — tek iş parçacığında pratikte olmaz) USDT komisyonlu teklife
 * düşer. Dönen quote'un `usdtCharge` alanı USDT bakiyeden ayrıca
 * düşülür (`useDnz` ise 0).
 */
function settleFeeDeduction(quote: FeeQuote, symbol: string, side: 'buy' | 'sell', notional: number): FeeQuote {
  if (!quote.useDnz) return quote
  const dnz = useDnzStore.getState()
  if (dnz.deductFeeDnz(quote.feeDnz, { symbol, side, notional })) return quote
  return quoteSpotFee(notional, { payWithDnz: false, dnzBalance: 0, dnzPrice: 0 })
}

/** Komisyonun USDT bacağını işlem defterine yazar (sıfırsa atlar). */
function recordFeeTx(
  symbol: string,
  side: 'buy' | 'sell',
  quantity: number,
  price: number,
  charge: number,
): void {
  if (!(charge > 0)) return
  void recordTransaction({
    userId: getSessionUserId() ?? '',
    type: 'fee',
    symbol,
    side,
    quantity: roundQty(quantity),
    price,
    amountUsdt: charge,
  })
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
  /** Spot ortalama maliyet (coin → USDT bazında ağırlıklı ortalama alış fiyatı).
   *  Ek alımlarda ortalama güncellenir; satışta ortalama korunur, miktar
   *  sıfırlanınca kayıt silinir. */
  spotAvgCosts: Record<string, number>
  /** Sanal AMM ortalama maliyet (sembol → token başına USDT). Aynı ortalama
   *  mantığı; sanal al/sat panelinden beslenir. */
  virtualAvgCosts: Record<string, number>
  spotTrades: SpotTrade[]
  spotPositions: SpotPosition[]
  /** Bekleyen sanal limit emirler (havuz fiyatı hedefe değince gerçekleşir). */
  virtualPending: VirtualPendingOrder[]
  /** Sanal TP/SL lotları (hedefe değince havuzda oto-satılır). */
  virtualTpSl: VirtualTpSl[]

  deposit: (amount: number, source?: DepositRecord['source']) => void
  withdraw: (amount: number) => void
  openPosition: (input: OrderInput) => OpenPositionResult
  closePosition: (id: string, marketPrice: number, reason?: 'manual' | 'liquidation' | 'tp_sl' | 'reduce') => void
  closeSpotPosition: (id: string, marketPrice: number) => void
  /**
   * İZOLE likidasyon: kaybedilebilecek azami tutar, açılışta kilitlenen
   * teminattır (zaten bakiyeden düşülmüştü). Serbest bakiye ve diğer
   * pozisyonlara DOKUNULMAZ — bakiye aynen korunur.
   */
  liquidateIsolated: (id: string, liquidationPrice: number) => void
  /**
   * ÇAPRAZ hesap tasfiyesi: portföy özsermayesi bakım gereksinimine
   * düşünce TÜM cross pozisyonlar birlikte kapatılır ve ortak havuz
   * (serbest + kilitli) sıfırlanır. İzole pozisyonlar etkilenmez.
   */
  liquidateCrossAccount: (marks: Record<string, number>) => void
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
  /**
   * Sanal AMM işleminin ortalama maliyet kaydı: buy'da ağırlıklı ortalama
   * güncellenir, sell'de ortalama korunur (miktar takibi cüzdan/havuzdadır).
   * `tokenQty` alınan/satılan adet, `usdtValue` işlemin USDT karşılığıdır.
   */
  recordVirtualTrade: (
    symbol: string,
    side: 'buy' | 'sell',
    tokenQty: number,
    usdtValue: number,
    prevHoldingQty?: number,
  ) => void
  /** Bekleyen sanal limit emir bırakır (havuz hedefe değince watchdog işletir). */
  placeVirtualPending: (input: Omit<VirtualPendingOrder, 'id' | 'at'>) => VirtualPendingOrder
  cancelVirtualPending: (id: string) => void
  /** Watchdog ateşlemesi: emri listeden düşer (icra çağrısı yapmaz). */
  takeVirtualPending: (id: string) => VirtualPendingOrder | null
  /** Sanal TP/SL lotu ekler (alışa bağlı oto-satış). */
  addVirtualTpSl: (input: Omit<VirtualTpSl, 'id' | 'openedAt'>) => VirtualTpSl
  /** Watchdog satışı: lotu listeden düşer (icra çağrısı yapmaz). */
  takeVirtualTpSl: (id: string) => VirtualTpSl | null
  cancelVirtualTpSl: (id: string) => void
  setBalance: (value: number) => void
  resetWallet: () => void
  /**
   * Margin-call bayrağı: kritik teminat uyarısı üretildiğinde damgalanır
   * (kademeli uyarı 2/2). Pozisyon toparlanırsa `clearMarginCalled` ile
   * temizlenir — bayrak cihazlar arası senkrona aynen taşınır.
   */
  markMarginCalled: (id: string) => void
  clearMarginCalled: (id: string) => void
  /**
   * Cihazlar arası senkron: sunucudaki işlem anlık görüntüsünü uygular.
   * Bakiyeye DOKUNMAZ (bakiye `profiles.balance` + useProfileSync'indir).
   */
  hydrateTradingState: (input: {
    positions: Position[]
    spotBalances: Record<string, number>
    spotPositions: SpotPosition[]
    trades: TradeRecord[]
    spotTrades: SpotTrade[]
  }) => void
}

const initialState = {
  balance: 0,
  positions: [],
  trades: [],
  deposits: [],
  withdrawals: [],
  promos: [],
  spotBalances: {},
  spotAvgCosts: {},
  virtualAvgCosts: {},
  spotTrades: [],
  spotPositions: [],
  virtualPending: [],
  virtualTpSl: [],
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
        // Sanal perpetual'larda kaldıraç tavanı 20x (panel + motor çift kilit).
        const effLeverage =
          input.mode === 'futures' ? clampFuturesLeverage(input.symbol, input.leverage) : 1
        if (positionSize(balance, input).quantity === 0 && input.quantity > 0) {
          return { ok: false, error: 'Insufficient balance for this order size.' }
        }
        const quantity = capQuantityByBalance(
          input.quantity,
          balance,
          input.entryPrice,
          effLeverage,
        )
        if (quantity <= 0) {
          return { ok: false, error: 'Amount must be greater than zero.' }
        }

        const marginNeeded = positionSize(balance, {
          ...input,
          quantity,
          leverage: effLeverage,
        }).margin

        const position: Position = {
          id: makeId('pos'),
          symbol: input.symbol,
          side: input.side,
          entryPrice: input.entryPrice,
          quantity,
          leverage: effLeverage,
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
        const margin = positionLockedMargin(position)

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

      liquidateIsolated: (id, liquidationPrice) => {
        const { positions, balance } = get()
        const position = positions.find((p) => p.id === id)
        if (!position) return

        // Kilitli teminat açılışta bakiyeden düşülmüştü; kayıp onunla
        // sınırlıdır — serbest bakiyeye DOKUNULMAZ (cross sanılmaz).
        const locked = positionLockedMargin(position)
        const record: TradeRecord = {
          id: makeId('trade'),
          symbol: position.symbol,
          side: position.side,
          mode: position.mode,
          quantity: position.quantity,
          entryPrice: position.entryPrice,
          exitPrice: liquidationPrice,
          leverage: position.leverage,
          pnl: -locked,
          reason: 'liquidation',
          closedAt: Date.now(),
        }

        set(() => ({
          positions: positions.filter((p) => p.id !== id),
          trades: [record, ...get().trades].slice(0, 200),
        }))
        // Bakiye değişmedi ama sunucuyla eşitlenir (oturum tutarlılığı).
        void pushBalanceToServer(getSessionUserId() ?? '', balance)

        void recordTransaction({
          userId: getSessionUserId() ?? '',
          type: position.side === 'long' ? 'trade_buy' : 'trade_sell',
          symbol: position.symbol,
          side: position.side === 'long' ? 'buy' : 'sell',
          quantity: position.quantity,
          price: liquidationPrice,
          amountUsdt: liquidationPrice * position.quantity,
        })
      },

      liquidateCrossAccount: (marks) => {
        const { positions } = get()
        const cross = positions.filter(
          (p) => p.mode === 'futures' && (p.marginMode ?? 'isolated') === 'cross',
        )
        if (cross.length === 0) return

        const records: TradeRecord[] = cross.map((position) => {
          const mark = marks[position.symbol] ?? position.entryPrice
          return {
            id: makeId('trade'),
            symbol: position.symbol,
            side: position.side,
            mode: position.mode,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            exitPrice: mark,
            leverage: position.leverage,
            pnl: calculatePnl(position, mark > 0 ? mark : position.entryPrice),
            reason: 'liquidation' as const,
            closedAt: Date.now(),
          }
        })
        const userId = getSessionUserId() ?? ''

        set((s) => ({
          balance: 0,
          positions: s.positions.filter(
            (p) => !(p.mode === 'futures' && (p.marginMode ?? 'isolated') === 'cross'),
          ),
          trades: [...records, ...s.trades].slice(0, 200),
        }))
        void pushBalanceToServer(userId, 0)

        for (const position of cross) {
          const mark = marks[position.symbol] ?? position.entryPrice
          void recordTransaction({
            userId,
            type: position.side === 'long' ? 'trade_buy' : 'trade_sell',
            symbol: position.symbol,
            side: position.side === 'long' ? 'buy' : 'sell',
            quantity: position.quantity,
            price: mark,
            amountUsdt: mark * position.quantity,
          })
        }
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
        // Oto-kapanış da normal satış komisyonuna tabidir (DNZ indirimi dahil).
        const quote = settleFeeDeduction(quoteFeeFor(proceeds), pos.symbol, 'sell', proceeds)
        set((s) => ({
          spotPositions: s.spotPositions.filter((p) => p.id !== id),
          spotBalances: {
            ...s.spotBalances,
            [coin]: roundQty(Math.max(0, held - qty)),
          },
          spotAvgCosts: (() => {
            const next = { ...s.spotAvgCosts }
            if (roundQty(Math.max(0, held - qty)) <= 0) delete next[coin]
            return next
          })(),
          balance: roundTo(s.balance + proceeds - quote.usdtCharge),
          spotTrades: [trade, ...s.spotTrades].slice(0, 200),
        }))
        void pushBalanceToServer(getSessionUserId() ?? '', get().balance)
        recordFeeTx(pos.symbol, 'sell', qty, marketPrice, quote.usdtCharge)
      },

      fillNow: (input) => {
        const {
          symbol, side, quantity, entryPrice, leverage = 1, mode,
          tpPrice, slPrice, triggerType, marginMode, reduceOnly, tif,
        } = input
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
          return { ok: false, error: 'Geçersiz emir miktarı.' }
        }
        const buy = side === 'buy' || side === 'long'

        if (mode === 'spot') {
          if (tif === 'FOK') {
            // Komisyon dahil tam tutar karşılanmalı (muhafazakâr USDT
            // tahmini; DNZ indirimi varsa gerçekleşme daha ucuza gelir).
            const total = quantity * entryPrice * (1 + SPOT_FEE_RATE)
            if (buy ? total > get().balance : quantity > (get().spotBalances[coinOf(symbol)] ?? 0)) {
              return { ok: false, error: 'FOK: tam miktar karşılanamıyor.' }
            }
          } else if (tif === 'IOC') {
            let qty = quantity
            if (buy) qty = Math.min(quantity, get().balance / (entryPrice * (1 + SPOT_FEE_RATE)))
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

        const lev = mode === 'futures' ? clampFuturesLeverage(symbol, leverage) : 1
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
        if (tpPrice || slPrice || marginMode) {
          const pid = res.position.id
          set((s) => ({
            positions: s.positions.map((p) =>
              p.id === pid
                ? {
                    ...p,
                    tpPrice: tpPrice || null,
                    slPrice: slPrice || null,
                    triggerType: triggerType || 'last',
                    ...(marginMode ? { marginMode } : {}),
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
        // Para kısıtı (depositBlocked) YALNIZCA kartla yüklemeyi ve para
        // çekmeyi kapsar; promosyon/referral bonusları kısıtlı hesaba da
        // işlenir. Bu yüzden burada kısıt kontrolü YOKTUR.
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
        const { balance, spotBalances, spotTrades, spotAvgCosts } = get()
        const coin = coinOf(symbol)
        // Önce saf teklif + bakiye kontrolü (kesinti YOK): başarısız
        // işlem ne DNZ ne USDT yakar. Sonra kesinti kesinleştirilir.
        let quote = quoteFeeFor(cost)
        if (cost + quote.usdtCharge > balance) {
          return { ok: false, error: 'Insufficient USDT balance.' }
        }
        quote = settleFeeDeduction(quote, symbol, 'buy', cost)
        if (cost + quote.usdtCharge > balance) {
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
        const prevQty = spotBalances[coin] ?? 0
        const prevAvg = spotAvgCosts[coin] ?? price
        const nextQty = roundQty(prevQty + roundQty(quantity))
        const nextAvg =
          prevQty > 0
            ? (prevQty * prevAvg + roundQty(quantity) * price) / (prevQty + roundQty(quantity))
            : price
        set({
          balance: Math.max(0, roundTo(balance - cost - quote.usdtCharge)),
          spotBalances: {
            ...spotBalances,
            [coin]: nextQty,
          },
          spotAvgCosts: { ...spotAvgCosts, [coin]: nextAvg },
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
        recordFeeTx(symbol, 'buy', quantity, price, quote.usdtCharge)
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
        const quote = settleFeeDeduction(quoteFeeFor(proceeds), symbol, 'sell', proceeds)
        const trade: SpotTrade = {
          id: makeId('spt'),
          symbol,
          side: 'sell',
          quantity: roundQty(quantity),
          price,
          at: Date.now(),
        }
        const nextQty = roundQty(held - quantity)
        set((s) => {
          const nextAvg = { ...s.spotAvgCosts }
          // Miktar sıfırlanınca maliyet kaydı da silinir (sıfırdan başlanır).
          if (nextQty <= 0) delete nextAvg[coin]
          return {
            balance: roundTo(balance + proceeds - quote.usdtCharge),
            spotBalances: {
              ...spotBalances,
              [coin]: nextQty,
            },
            spotAvgCosts: nextAvg,
            spotTrades: [trade, ...spotTrades].slice(0, 200),
          }
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
        recordFeeTx(symbol, 'sell', quantity, price, quote.usdtCharge)
        return { ok: true }
      },

      setBalance: (value) => {
        if (!Number.isFinite(value) || value < 0) return
        set({ balance: roundTo(value) })
      },

      placeVirtualPending: (input) => {
        const order: VirtualPendingOrder = { ...input, id: makeId('vp'), at: Date.now() }
        set((s) => ({ virtualPending: [...s.virtualPending, order] }))
        return order
      },

      cancelVirtualPending: (id) => {
        set((s) => ({ virtualPending: s.virtualPending.filter((o) => o.id !== id) }))
      },

      takeVirtualPending: (id) => {
        const found = get().virtualPending.find((o) => o.id === id) ?? null
        if (found) {
          set((s) => ({ virtualPending: s.virtualPending.filter((o) => o.id !== id) }))
        }
        return found
      },

      addVirtualTpSl: (input) => {
        const lot: VirtualTpSl = { ...input, id: makeId('vtpsl'), openedAt: Date.now() }
        set((s) => ({ virtualTpSl: [...s.virtualTpSl, lot] }))
        return lot
      },

      takeVirtualTpSl: (id) => {
        const found = get().virtualTpSl.find((l) => l.id === id) ?? null
        if (found) {
          set((s) => ({ virtualTpSl: s.virtualTpSl.filter((l) => l.id !== id) }))
        }
        return found
      },

      cancelVirtualTpSl: (id) => {
        set((s) => ({ virtualTpSl: s.virtualTpSl.filter((l) => l.id !== id) }))
      },

      recordVirtualTrade: (symbol, side, tokenQty, usdtValue, prevHoldingQty = 0) => {
        const key = symbol.trim().toUpperCase()
        if (!key || !Number.isFinite(tokenQty) || tokenQty <= 0) return
        if (side === 'sell') return
        if (!Number.isFinite(usdtValue) || usdtValue <= 0) return
        // Ek alımlarda ağırlıklı ortalama: (eskiAdet*eskiOrt + yeniAdet*yeniFiyat) / toplam.
        const buyPrice = usdtValue / tokenQty
        set((s) => {
          const prevAvg = s.virtualAvgCosts[key] ?? buyPrice
          const prevQty = Number.isFinite(prevHoldingQty) && prevHoldingQty > 0 ? prevHoldingQty : 0
          const nextAvg =
            prevQty > 0 ? (prevQty * prevAvg + tokenQty * buyPrice) / (prevQty + tokenQty) : buyPrice
          return { virtualAvgCosts: { ...s.virtualAvgCosts, [key]: nextAvg } }
        })
      },

      resetWallet: () => set({ ...initialState }),

      markMarginCalled: (id) => {
        set((s) => ({
          positions: s.positions.map((p) =>
            p.id === id && !p.marginCalledAt ? { ...p, marginCalledAt: Date.now() } : p,
          ),
        }))
      },

      clearMarginCalled: (id) => {
        set((s) => ({
          positions: s.positions.map((p) =>
            p.id === id && p.marginCalledAt ? { ...p, marginCalledAt: null } : p,
          ),
        }))
      },

      hydrateTradingState: (input) => {
        set({
          positions: [...input.positions],
          spotBalances: { ...input.spotBalances },
          spotPositions: [...input.spotPositions],
          trades: [...input.trades].slice(0, 200),
          spotTrades: [...input.spotTrades].slice(0, 200),
        })
      },
    }),
    {
      name: WALLET_STORAGE_KEY,
      storage: createJSONStorage(() => createWalletStorage()),
    },
  ),
)