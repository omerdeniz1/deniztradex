import { VIRTUAL_AMM_FEE_RATE } from '@/engine/virtualAmm'
import { FORUM_POST_MAX_LENGTH, createForumPost } from '@/services/forumService'
import { updateCoinStatus, type CoinStatus } from '@/services/adminService'
import {
  executeBotPoolTrade,
  listVirtualCoins,
  type VirtualTradeResult,
} from '@/services/virtualMarketService'

/**
 * Haberle Yükselt / Haberle Düşür (admin → Coinler).
 *
 * Akış sırası (kullanıcı isteği):
 *  1) Admin haberi girer (başlık + metin).
 *  2) Haber coin paneline işlenir + forumda yayınlanır.
 *  3) Fiyat hareketi gelir — ne az ne çok: hedef %1.8.
 *
 * Fiyat hareketi SADECE sanal havuzlarda mümkündür (gerçek piyasa
 * sembollerinde haber+forum yayınlanır, fiyat adımı atlanır).
 */

export const NEWS_PUMP_TARGET_PCT = 1.8
export const NEWS_TITLE_MAX = 200
export const NEWS_BODY_MAX = 2000

export type PumpDirection = 'up' | 'down'

export interface PumpResult {
  symbol: string
  direction: PumpDirection
  /** Haberin hedeflediği fiyat etkisi (%). */
  targetPct: number
  /** Gerçekleşen fiyat etkisi (sanal havuz yoksa null). */
  impactPct: number | null
  trade: VirtualTradeResult | null
  forumPostId: string
  newsSaved: boolean
  summary: string
}

/**
 * Hedef yüzde için gereken USDT tutarı (saf AMM matematiği, ücret dahil).
 * - Alış: oran = (1 + d(1-f)/R)^2  →  d = R(√(1+p)−1)/(1−f)
 * - Satış (USDT-çıkış u): oran = (1−u/R)^2  →  u = R(1−√(1−p))
 */
export function computeNewsPumpAmount(
  reserveUsdt: number,
  direction: PumpDirection,
  targetPct: number = NEWS_PUMP_TARGET_PCT,
): number {
  if (!Number.isFinite(reserveUsdt) || reserveUsdt <= 0) {
    throw new Error('Havuz derinliği yetersiz.')
  }
  if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct >= 20) {
    throw new Error('Geçersiz hedef yüzde.')
  }
  const p = targetPct / 100
  const f = VIRTUAL_AMM_FEE_RATE
  if (direction === 'up') {
    return (reserveUsdt * (Math.sqrt(1 + p) - 1)) / (1 - f)
  }
  return reserveUsdt * (1 - Math.sqrt(1 - p))
}

function validateNewsInput(title: string, body: string): { title: string; body: string } {
  const t = title.trim()
  const b = body.trim()
  if (!t) throw new Error('Haber başlığı gerekli.')
  if (!b) throw new Error('Haber metni gerekli.')
  if (t.length > NEWS_TITLE_MAX) {
    throw new Error(`Başlık en fazla ${NEWS_TITLE_MAX} karakter olabilir.`)
  }
  if (b.length > NEWS_BODY_MAX) {
    throw new Error(`Metin en fazla ${NEWS_BODY_MAX} karakter olabilir.`)
  }
  return { title: t, body: b }
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}`
}

/**
 * Haberli fiyat hareketi: önce haber (panel + forum), sonra havuz hamlesi.
 * `keepStatus` — coinin mevcut yönetim durumudur; haber kaydı durumu
 * DEĞİŞTİRMEZ (sıfırlama yok).
 */
export async function pumpCoinWithNews(
  symbol: string,
  direction: PumpDirection,
  rawTitle: string,
  rawBody: string,
  keepStatus: CoinStatus = 'normal',
  targetPct: number = NEWS_PUMP_TARGET_PCT,
): Promise<PumpResult> {
  const key = symbol.trim().toUpperCase()
  if (!key) throw new Error('Geçersiz sembol.')
  const { title, body } = validateNewsInput(rawTitle, rawBody)

  const coins = await listVirtualCoins().catch(() => [])
  const pool = coins.find((c) => c.symbol.toUpperCase() === key)
  const arrow = direction === 'up' ? '📈' : '📉'

  // 1) Haber kaydı (admin ortamı; çevrimdışı/testte sessiz geçilir).
  let newsSaved = false
  try {
    await updateCoinStatus(key, keepStatus, title, body)
    newsSaved = true
  } catch {
    // Yerel/çevrimdışı modda haber tablosu yok — forum + havuz yine işler.
  }

  // 2) Forum yayını (oturumdaki admin adına; mavi/sarı tik aynen gelir).
  const forumText = `${arrow} ${key} — ${title}\n${body}`.slice(0, FORUM_POST_MAX_LENGTH)
  const forumPost = await createForumPost(forumText)

  // 3) Fiyat hareketi (yalnızca sanal havuz).
  if (!pool || !(pool.reserveUsdt > 0)) {
    return {
      symbol: key,
      direction,
      targetPct,
      impactPct: null,
      trade: null,
      forumPostId: forumPost.id,
      newsSaved,
      summary: `${key}: haber yayınlandı (forum${newsSaved ? ' + panel' : ''}) — gerçek piyasa coini, fiyat adımı yok.`,
    }
  }
  const amount = computeNewsPumpAmount(pool.reserveUsdt, direction, targetPct)
  const trade = await executeBotPoolTrade(key, direction === 'up' ? 'buy' : 'sell', amount)
  return {
    symbol: key,
    direction,
    targetPct,
    impactPct: trade.priceImpactPct,
    trade,
    forumPostId: forumPost.id,
    newsSaved,
    summary: `${key} %${fmtPct(trade.priceImpactPct)} · haber yayınlandı (forum${newsSaved ? ' + panel' : ''})`,
  }
}
