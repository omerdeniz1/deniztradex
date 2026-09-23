import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  VIRTUAL_SEED,
  executeAutoPoolTradeLocal,
  listVirtualCoins,
  type VirtualCoin,
  type VirtualTradeSide,
} from '@/services/virtualMarketService'
import { getRiskParams } from '@/services/riskConfigService'

/**
 * Otomatik Piyasa Botları — arka planda sanal coinleri sürekli oynatır.
 *
 * Her tikte 1-3 rastgele coinde küçük USDT hamlesi yapılır (al-sat):
 * fiyat oynar, `volume_24h` büyür, 1m mumu güncellenir. Kullanıcı
 * bakiyelerine DOKUNULMAZ, foruma mesaj düşülmez.
 *
 * - Yerel/çevrimdışı mod: havuz doğrudan localStorage'da oynatılır
 *   (oturum gerekmez — her ziyaretçide çalışır).
 * - Supabase modu: `execute_auto_market_trade` RPC'si. Bu RPC admin
 *   ZORUNLU TUTMAZ; sunucu tarafında hamle havuzun binde 1'i ile
 *   sınırlıdır, yani istemci ne gönderirse göndersin havuz boşalamaz.
 *   Migration henüz uygulanmadıysa tik sessizce atlanır (bayrak
 *   `isAutoMarketRpcMissing` ile admin panelde uyarılır).
 *
 * Fiyatın tek yöne kaçmaması için ortalama-dönüş (mean-reversion)
 * bandı vardır: fiyat tohum fiyatından %6'dan fazla saparsa botlar
 * ters yöne ağırlıklı oynar.
 */

export type AutoBotIntensity = 'calm' | 'normal' | 'lively'

export interface AutoBotConfig {
  enabled: boolean
  /** Tik aralığı (ms, istemci tarafı). */
  intervalMs: number
  intensity: AutoBotIntensity
}

export const DEFAULT_AUTO_BOT_CONFIG: AutoBotConfig = {
  enabled: true,
  intervalMs: 12000,
  intensity: 'normal',
}

export const AUTO_BOT_INTENSITY_LABEL: Record<AutoBotIntensity, string> = {
  calm: 'Sakin',
  normal: 'Normal',
  lively: 'Hareketli',
}

const CONFIG_KEY = 'deniztradx_auto_bot_config'
/** Sunucu RPC'si yoksa her tikte hata basmamak için tek seferlik bayrak. */
let rpcMissingWarned = false

export function isAutoMarketRpcMissing(): boolean {
  return rpcMissingWarned
}

function clampInterval(ms: unknown): number {
  const n = typeof ms === 'number' ? ms : parseInt(String(ms ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_AUTO_BOT_CONFIG.intervalMs
  return Math.min(120000, Math.max(4000, Math.floor(n)))
}

function clampIntensity(v: unknown): AutoBotIntensity {
  return v === 'calm' || v === 'lively' ? v : 'normal'
}

/** İstemci ayarı: önce Supabase `auto_bot_config`, yoksa localStorage. */
export async function getAutoBotConfig(): Promise<AutoBotConfig> {
  const local = readLocalConfig()
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('auto_bot_config')
        .select('enabled,interval_sec,intensity')
        .eq('id', 1)
        .maybeSingle()
      if (!error && data) {
        const row = data as Record<string, unknown>
        return {
          enabled: row.enabled !== false,
          intervalMs: clampInterval(Number(row.interval_sec) * 1000 || local.intervalMs),
          intensity: clampIntensity(String(row.intensity ?? '')),
        }
      }
    } catch {
      // tablo yok / ağ hatası — yerel ayara düş
    }
  }
  return local
}

export function getLocalAutoBotConfig(): AutoBotConfig {
  return readLocalConfig()
}

function readLocalConfig(): AutoBotConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<AutoBotConfig>
      return {
        enabled: p.enabled !== false,
        intervalMs: clampInterval(p.intervalMs),
        intensity: clampIntensity(p.intensity),
      }
    }
  } catch {
    // yoksay — varsayılan
  }
  return { ...DEFAULT_AUTO_BOT_CONFIG }
}

/**
 * Admin kaydı: localStorage + (varsa) Supabase. Sunucu yazımı yalnızca
 * süper admin RPC'sinden geçer; yetkisizde yerel ayar yine saklanır.
 */
export async function saveAutoBotConfig(next: AutoBotConfig): Promise<void> {
  const clean: AutoBotConfig = {
    enabled: next.enabled,
    intervalMs: clampInterval(next.intervalMs),
    intensity: clampIntensity(next.intensity),
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(clean))
  } catch {
    // yoksay
  }
  if (isSupabaseConfigured && supabase) {
    try {
      await supabase.rpc('update_auto_bot_config', {
        p_enabled: clean.enabled,
        p_interval_sec: Math.round(clean.intervalMs / 1000),
        p_intensity: clean.intensity,
      })
    } catch {
      // tablo/RPC yoksa yerel ayar geçerlidir
    }
  }
}

// ---------------------------------------------------------------
// Hamle seçimi (saf fonksiyon — test edilebilir)
// ---------------------------------------------------------------

export interface AutoTradePlan {
  symbol: string
  side: VirtualTradeSide
  /** Havuz USDT rezervinin oranı (örn. 0.0002 = on-binde 2). */
  fraction: number
}

/**
 * Yoğunluğa göre hamle büyüklüğü aralığı (rezerv oranı).
 * Etki ≈ 2·oran: lively üst sınır (%0.15) tik başına ~%0.3 fiyat oynatır —
 * görünür çalkantı, tek tikte asla yıkım yok (sunucu cap'i ayrıca kırpar).
 */
const FRACTION_RANGE: Record<AutoBotIntensity, [number, number]> = {
  calm: [0.00005, 0.00025],
  normal: [0.00015, 0.0007],
  lively: [0.0004, 0.0015],
}

/** Tik başına coin sayısı (yoğunluğa göre 1-5). */
const COINS_PER_TICK: Record<AutoBotIntensity, [number, number]> = {
  calm: [1, 2],
  normal: [2, 3],
  lively: [3, 5],
}

/** İstemci hamlesi tavanı (rezerv oranı) — sunucu RPC cap'iyle uyumlu. */
export const AUTO_BOT_CLIENT_MAX_FRACTION = 0.002

/** Ortalama-dönüş bandı: tohum fiyattan bu orandan fazla sapma → ters yön baskısı. */
export const AUTO_BOT_REVERT_BAND = 0.06

const SEED_PRICE: Record<string, number> = Object.fromEntries(
  VIRTUAL_SEED.map((s) => [s.symbol.toUpperCase(), s.price]),
)

export function planAutoTrades(
  coins: VirtualCoin[],
  intensity: AutoBotIntensity,
  rand: () => number = Math.random,
): AutoTradePlan[] {
  const pool = coins.filter((c) => c.reserveUsdt > 0 && c.price > 0)
  if (pool.length === 0) return []
  const [lo, hi] = FRACTION_RANGE[intensity] ?? FRACTION_RANGE.normal
  const [cLo, cHi] = COINS_PER_TICK[intensity] ?? COINS_PER_TICK.normal
  const count = cLo + Math.floor(rand() * (cHi - cLo + 1))
  const picked = [...pool].sort(() => rand() - 0.5).slice(0, Math.min(count, pool.length))
  return picked.map((c) => {
    const seed = SEED_PRICE[c.symbol.toUpperCase()] ?? c.price
    const drift = (c.price - seed) / seed
    let buyProb = 0.5
    if (drift > AUTO_BOT_REVERT_BAND) buyProb = 0.3
    else if (drift < -AUTO_BOT_REVERT_BAND) buyProb = 0.7
    const side: VirtualTradeSide = rand() < buyProb ? 'buy' : 'sell'
    // Bant dışıysa hamleyi biraz büyüt (dönüşü hızlandır), bant içinde küçük tut.
    const boost = Math.abs(drift) > AUTO_BOT_REVERT_BAND ? 1.6 : 1
    const fraction = Math.min(AUTO_BOT_CLIENT_MAX_FRACTION, (lo + rand() * (hi - lo)) * boost)
    return { symbol: c.symbol, side, fraction }
  })
}

// ---------------------------------------------------------------
// Tik yürütme
// ---------------------------------------------------------------

export interface AutoTickResult {
  symbol: string
  side: VirtualTradeSide
  usdtAmount: number
  priceImpactPct: number
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? (n as number) : 0
}

function isMissingRpcError(error: unknown): boolean {
  const msg = String((error as { message?: unknown })?.message ?? '').toLowerCase()
  const code = String((error as { code?: unknown })?.code ?? '')
  return (
    code === '42883' ||
    msg.includes('execute_auto_market_trade') ||
    (msg.includes('function') && msg.includes('does not exist')) ||
    msg.includes('could not find the function')
  )
}

/**
 * Tek oto-bot tikini çalıştır: planla → havuzda uygula.
 * Devre dışıysa / coinsizse / RPC eksikse `[]` döner (sessiz).
 */
export async function runAutoBotTick(
  intensity: AutoBotIntensity = 'normal',
): Promise<AutoTickResult[]> {
  let coins: VirtualCoin[]
  try {
    coins = await listVirtualCoins()
  } catch {
    return []
  }
  const plans = planAutoTrades(coins, intensity)
  if (plans.length === 0) return []

  let capFraction = 0.02
  try {
    capFraction = (await getRiskParams()).botMaxPoolFraction
  } catch {
    // varsayılan cap
  }

  const out: AutoTickResult[] = []
  for (const plan of plans) {
    const coin = coins.find((c) => c.symbol === plan.symbol)
    if (!coin || !(coin.reserveUsdt > 0)) continue
    const raw = coin.reserveUsdt * plan.fraction
    const usdtAmount = Math.min(raw, coin.reserveUsdt * capFraction)
    if (!(usdtAmount > 0)) continue

    try {
      if (isSupabaseConfigured && supabase) {
        const { data, error } = await supabase.rpc('execute_auto_market_trade', {
          p_symbol: plan.symbol,
          p_trade_type: plan.side,
          p_usdt_amount: usdtAmount,
        })
        if (error) {
          if (isMissingRpcError(error)) {
            if (!rpcMissingWarned) {
              rpcMissingWarned = true
              // eslint-disable-next-line no-console
              console.warn(
                '[auto-bot] execute_auto_market_trade RPC bulunamadı — ' +
                  'supabase/migrations/20260923000000_auto_market_maker.sql uygulanmalı.',
              )
            }
            continue
          }
          continue
        }
        const r = data as Record<string, unknown> | null
        if (!r || r.ok !== true) continue
        out.push({
          symbol: plan.symbol,
          side: plan.side,
          usdtAmount: toNumber(r.usdt_amount),
          priceImpactPct: toNumber(r.price_impact_pct),
        })
      } else {
        const trade = executeAutoPoolTradeLocal(plan.symbol, plan.side, usdtAmount)
        out.push({
          symbol: plan.symbol,
          side: plan.side,
          usdtAmount: trade.usdtAmount,
          priceImpactPct: trade.priceImpactPct,
        })
      }
    } catch {
      // Tek hamle hatası tüm tiki durdurmaz.
    }
  }
  return out
}
