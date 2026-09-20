import {
  executeBotPoolTrade,
  listVirtualCoins,
  VIRTUAL_SEED,
  type VirtualCoin,
  type VirtualTradeResult,
  type VirtualTradeSide,
} from '@/services/virtualMarketService'
import { getSessionUserId } from '@/services/authService'

/**
 * Perakende (retail) botu — halkın sürekli al-sat yaptığı canlı piyasa hissi.
 *
 * - 2–7 sn arasında rastgele sürelerle tetiklenir (`setTimeout` zinciri).
 * - Sanal coin listesinden rastgele coin seçer (DNZ dahil — liste her
 *   tur tazelenir, yeni coinler otomatik katılır).
 * - 10–150$ bandında perakende hacim + %50 alım / %50 satım.
 * - Emirler AMM havuzuna işlenir (`executeBotPoolTrade` — kullanıcı
 *   bakiyesine DOKUNULMAZ, yalnızca havuz oynar).
 * - Her baskı anlık yayınlanır (`onRetailTrade` abone listesi —
 *   bant/tape arayüzleri buradan beslenir; grafikler mevcut 15 sn
 *   yoklamayla tazelenir).
 *
 * FİZİK NOTU: mikro etki bandı (%0.01–0.1) havuz derinliğine göre
 * ölçeklenir — derin havuzda aynı yüzde için büyük tutar gerekir
 * (etki ≈ 2·tutar/rezerv). Tutar = U(10,150) · max(1, R/250B) ve
 * 5.000$ sert tavan: sığ havuzlarda gerçek perakende fişleri, derin
 * havuzlarda (DNZ dahil) görünür mikro kıpırtı üretir. Bantta yazan
 * GERÇEK USD tutarıdır; gerçekleşen etki her baskıda raporlanır.
 *
 * GÜVENLİK/YERLEŞİM: uzak havuz yazımı (`execute_bot_trade` RPC'si)
 * süper-admin ister. Bot, admin oturumunda ORTAK havuzları oynatır;
 * yetkisiz oturumda otomatik YEREL moda düşer (tek cihaz simülasyonu).
 * Bu yüzden HER ZİYARETÇİDE ÇALIŞTIRMAYIN — kalabalık hissi için
 * TEK bir admin sekmesinde (veya vitrin cihazında) açın:
 *   localStorage: deniztradx_retail_bot = "1"  (veya VITE_RETAIL_BOT=1)
 * Başlatma: `maybeAutoStartRetailBot()` (main.tsx — örneğe bakın).
 */

export const RETAIL_MIN_DELAY_MS = 2000
export const RETAIL_MAX_DELAY_MS = 7000
export const RETAIL_MIN_USD = 10
export const RETAIL_MAX_USD = 150
/** Derinlik referansı: etki ≈ 2·tutar/R denkleminden %0.008–0.12 bandı verir. */
export const RETAIL_REF_POOL_USDT = 250_000
/** Derin havuzlardaki perakende fişi tavanı (USD). */
export const RETAIL_HARD_CAP_USD = 5000
export const RETAIL_FLAG_KEY = 'deniztradx_retail_bot'

export type RetailSide = VirtualTradeSide

export interface RetailPrint {
  at: number
  symbol: string
  side: RetailSide
  /** Fiş tutarı (USD) — bantta yazan gerçek değer. */
  usdt: number
  tokenAmount: number
  usdtAmount: number
  /** Gerçekleşen fiyat etkisi (%). */
  priceImpactPct: number
  /** Uzak (ortak) havuz mu, yerel (cihaz) havuz mu? */
  source: 'remote' | 'local'
}

export interface RetailBotStatus {
  running: boolean
  /** Uzak havuza yazabiliyor mu? (false → yerel mod + gerekçe) */
  remote: boolean
  localOnly: boolean
  localOnlyReason: string | null
  trades: number
  errors: number
  skipped: number
  startedAt: number | null
  lastPrint: RetailPrint | null
}

type Rng = () => number

/** Sonraki tetikleme gecikmesi: 2000–7000 ms uniform. */
export function nextRetailDelayMs(rng: Rng = Math.random): number {
  const r = Math.min(Math.max(rng(), 0), 0.999999)
  return Math.floor(RETAIL_MIN_DELAY_MS + r * (RETAIL_MAX_DELAY_MS - RETAIL_MIN_DELAY_MS + 1))
}

/** %50 alım / %50 satım. */
export function pickRetailSide(rng: Rng = Math.random): RetailSide {
  return rng() < 0.5 ? 'buy' : 'sell'
}

/**
 * Perakende fiş tutarı (USD): U(10,150) · max(1, R/250B), tavan 5000$.
 * Derin havuzda aynı mikro etki için büyük fiş gerekir — formül etkiyi
 * havuzdan bağımsız ~%0.008–0.12 bandında tutar.
 */
export function retailOrderSize(reserveUsdt: number, rng: Rng = Math.random): number {
  const r = Math.min(Math.max(rng(), 0), 0.999999)
  const base = RETAIL_MIN_USD + r * (RETAIL_MAX_USD - RETAIL_MIN_USD)
  const depthFactor = Number.isFinite(reserveUsdt) && reserveUsdt > 0
    ? Math.max(1, reserveUsdt / RETAIL_REF_POOL_USDT)
    : 1
  const sized = Math.round(base * depthFactor * 100) / 100
  return Math.min(Math.max(sized, RETAIL_MIN_USD), RETAIL_HARD_CAP_USD)
}

/** Rastgele coin (rezervi pozitif olanlar; tohum yedeğiyle). */
export function pickRetailCoin(
  coins: Pick<VirtualCoin, 'symbol' | 'reserveUsdt' | 'reserveToken'>[],
  rng: Rng = Math.random,
): Pick<VirtualCoin, 'symbol' | 'reserveUsdt' | 'reserveToken'> | null {
  const pool = (Array.isArray(coins) ? coins : []).filter(
    (c) => c && typeof c.symbol === 'string' && c.symbol && c.reserveUsdt > 0 && c.reserveToken > 0,
  )
  if (pool.length === 0) return null
  return pool[Math.floor(rng() * pool.length) % pool.length] ?? null
}

async function loadUniverse(): Promise<Pick<VirtualCoin, 'symbol' | 'reserveUsdt' | 'reserveToken'>[]> {
  try {
    const list = await listVirtualCoins()
    if (Array.isArray(list) && list.length > 0) return list
  } catch {
    // tohum yedeğine düş
  }
  return [...VIRTUAL_SEED]
}

type Listener = (print: RetailPrint) => void

interface EngineState {
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  localOnly: boolean
  localOnlyReason: string | null
  remoteWarned: boolean
  trades: number
  errors: number
  skipped: number
  startedAt: number | null
  lastPrint: RetailPrint | null
  listeners: Set<Listener>
}

const state: EngineState = {
  timer: null,
  running: false,
  localOnly: false,
  localOnlyReason: null,
  remoteWarned: false,
  trades: 0,
  errors: 0,
  skipped: 0,
  startedAt: null,
  lastPrint: null,
  listeners: new Set(),
}

function emit(print: RetailPrint): void {
  state.lastPrint = print
  for (const cb of state.listeners) {
    try {
      cb(print)
    } catch {
      // abone hatası motoru durdurmaz
    }
  }
}

function schedule(): void {
  if (!state.running) return
  state.timer = setTimeout(() => {
    void tick().finally(() => schedule())
  }, nextRetailDelayMs())
}

/** Tek perakende baskısı: seç → boyutlandır → havuza işlet → yayınla. */
export async function retailTickOnce(): Promise<RetailPrint | null> {
  const userId = getSessionUserId()
  if (!userId) {
    state.skipped += 1
    return null
  }
  const coins = await loadUniverse()
  const coin = pickRetailCoin(coins)
  if (!coin) {
    state.skipped += 1
    return null
  }
  const side = pickRetailSide()
  const usdt = retailOrderSize(coin.reserveUsdt)
  let res: VirtualTradeResult
  let source: RetailPrint['source'] = 'local'
  try {
    res = await executeBotPoolTrade(coin.symbol, side, usdt, {
      localOnly: state.localOnly,
    })
    source = state.localOnly ? 'local' : 'remote'
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // Uzak yetki duvarı (süper-admin değil) → kalıcı yerel moda düş.
    if (!state.localOnly && /yetkin yok|yetkisiz|admin/i.test(msg)) {
      state.localOnly = true
      state.localOnlyReason = msg || 'Uzak havuz yazımı için süper-admin gerekli.'
      if (!state.remoteWarned) {
        state.remoteWarned = true
        console.warn(`[retail-bot] ${state.localOnlyReason} Yerel havuzlarla devam ediliyor.`)
      }
      try {
        res = await executeBotPoolTrade(coin.symbol, side, usdt, { localOnly: true })
        source = 'local'
      } catch (inner) {
        state.errors += 1
        throw inner instanceof Error ? inner : new Error('İşlem yapılamadı.')
      }
    } else {
      state.errors += 1
      throw err instanceof Error ? err : new Error('İşlem yapılamadı.')
    }
  }
  const print: RetailPrint = {
    at: Date.now(),
    symbol: coin.symbol,
    side,
    usdt,
    tokenAmount: res.tokenAmount,
    usdtAmount: res.usdtAmount,
    priceImpactPct: res.priceImpactPct,
    source,
  }
  state.trades += 1
  emit(print)
  return print
}

async function tick(): Promise<void> {
  if (!state.running) return
  try {
    await retailTickOnce()
  } catch {
    // hatalar sayaca işlenir; döngü durmaz (havuz/ağ aksaklığına dayanıklı)
  }
}

/**
 * Motoru başlatır (idempotent — StrictMode çift çağrısı tek döngü kurar).
 * @returns true: yeni başlatıldı, false: zaten çalışıyordu.
 */
export function startRetailBot(): boolean {
  if (state.running) return false
  state.running = true
  state.startedAt = Date.now()
  schedule()
  return true
}

/** Motoru durdurur (zamanlayıcı temizlenir; istatistik korunur). */
export function stopRetailBot(): void {
  state.running = false
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
}

/** Testler / sıcak yeniden başlatma için sayacı sıfırlar (döngüye dokunmaz). */
export function resetRetailBotStats(): void {
  state.trades = 0
  state.errors = 0
  state.skipped = 0
  state.startedAt = null
  state.lastPrint = null
  state.localOnly = false
  state.localOnlyReason = null
  state.remoteWarned = false
}

export function isRetailBotRunning(): boolean {
  return state.running
}

export function getRetailBotStatus(): RetailBotStatus {
  return {
    running: state.running,
    remote: state.running && !state.localOnly,
    localOnly: state.localOnly,
    localOnlyReason: state.localOnlyReason,
    trades: state.trades,
    errors: state.errors,
    skipped: state.skipped,
    startedAt: state.startedAt,
    lastPrint: state.lastPrint,
  }
}

/** Baskı akışına abone ol (bant/tape arayüzleri). Dönüş: abonelik iptali. */
export function onRetailTrade(cb: Listener): () => void {
  state.listeners.add(cb)
  return () => {
    state.listeners.delete(cb)
  }
}

/**
 * Otomatik başlatma (main.tsx): `localStorage deniztradx_retail_bot ===
 * "1"` veya `VITE_RETAIL_BOT=1` ise motoru kurar + konsol kısayolu bırakır.
 * Varsayılan KAPALI — her ziyaretçide çalışmamalı (tek admin sekmesi).
 */
export function maybeAutoStartRetailBot(): boolean {
  let flag = false
  try {
    flag = localStorage.getItem(RETAIL_FLAG_KEY) === '1'
  } catch {
    // yoksay
  }
  if (!flag) {
    try {
      flag = (import.meta.env.VITE_RETAIL_BOT ?? '') === '1'
    } catch {
      // yoksay
    }
  }
  try {
    const g = globalThis as unknown as { __retailBot?: unknown }
    g.__retailBot = {
      start: startRetailBot,
      stop: stopRetailBot,
      status: getRetailBotStatus,
      onPrint: onRetailTrade,
    }
  } catch {
    // yoksay
  }
  if (!flag) return false
  return startRetailBot()
}
