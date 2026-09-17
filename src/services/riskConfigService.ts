import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  BOT_MAX_POOL_FRACTION,
  LIQ_CONFIRM_TICKS,
  MAINTENANCE_MARGIN_RATE,
  MARGIN_CALL_CRITICAL_LOSS_FRAC,
  MARGIN_CALL_WARN_LOSS_FRAC,
  MARK_PRICE_WINDOW,
} from '@/engine/calculations'

/**
 * Risk yapılandırması — DB (`risk_config` tek satırı) + güvenli varsayılan.
 *
 * Çevrimdışı / tablo yok / ağ hatası → varsayılanlarla devam (uygulama
 * asla kilitlenmez). Başarılı okuma 60 sn önbelleğe alınır; sıcak
 * likidasyon yolunda her tikte sorgu atılmaz.
 */

export interface RiskParams {
  maintenanceMarginRate: number
  warnLossFrac: number
  criticalLossFrac: number
  liqConfirmTicks: number
  markPriceWindow: number
  botMaxPoolFraction: number
}

export const DEFAULT_RISK_PARAMS: RiskParams = {
  maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
  warnLossFrac: MARGIN_CALL_WARN_LOSS_FRAC,
  criticalLossFrac: MARGIN_CALL_CRITICAL_LOSS_FRAC,
  liqConfirmTicks: LIQ_CONFIRM_TICKS,
  markPriceWindow: MARK_PRICE_WINDOW,
  botMaxPoolFraction: BOT_MAX_POOL_FRACTION,
}

let cache: { at: number; params: RiskParams } | null = null
const CACHE_TTL_MS = 60_000

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  return Math.floor(num(v, fallback, min, max))
}

/** Testlerde önbelleği sıfırlar. */
export function resetRiskParamsCache(): void {
  cache = null
}

export async function getRiskParams(): Promise<RiskParams> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.params
  if (!isSupabaseConfigured || !supabase) return { ...DEFAULT_RISK_PARAMS }
  try {
    const { data, error } = await supabase
      .from('risk_config')
      .select(
        'maintenance_margin_rate,margin_call_warn_loss_frac,margin_call_critical_loss_frac,liq_confirm_ticks,mark_price_window,bot_max_pool_fraction',
      )
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) return { ...DEFAULT_RISK_PARAMS }
    const row = data as Record<string, unknown>
    const warn = num(row.margin_call_warn_loss_frac, DEFAULT_RISK_PARAMS.warnLossFrac, 0.01, 0.99)
    let critical = num(
      row.margin_call_critical_loss_frac,
      DEFAULT_RISK_PARAMS.criticalLossFrac,
      0.01,
      0.99,
    )
    // Bozuk satırda merdiven ters dönmesin: kritik > uyarı garantisi.
    if (critical <= warn) critical = Math.min(0.99, warn + 0.1)
    const params: RiskParams = {
      maintenanceMarginRate: num(row.maintenance_margin_rate, DEFAULT_RISK_PARAMS.maintenanceMarginRate, 0, 0.1),
      warnLossFrac: warn,
      criticalLossFrac: critical,
      liqConfirmTicks: int(row.liq_confirm_ticks, DEFAULT_RISK_PARAMS.liqConfirmTicks, 1, 20),
      markPriceWindow: int(row.mark_price_window, DEFAULT_RISK_PARAMS.markPriceWindow, 1, 50),
      botMaxPoolFraction: num(row.bot_max_pool_fraction, DEFAULT_RISK_PARAMS.botMaxPoolFraction, 0.001, 0.2),
    }
    cache = { at: Date.now(), params }
    return params
  } catch {
    return { ...DEFAULT_RISK_PARAMS }
  }
}
