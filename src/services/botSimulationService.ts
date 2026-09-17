import { createBotForumPost } from '@/services/forumService'
import {
  executeBotPoolTrade,
  listVirtualCoins,
  type VirtualTradeResult,
} from '@/services/virtualMarketService'
import { getRiskParams } from '@/services/riskConfigService'

/**
 * Bot Simülasyon Motoru — piyasa manipülasyon testleri (YALNIZCA süper
 * admin, Admin → Bot Test Paneli).
 *
 * Her bot önce foruma personasına uygun mesaj düşer (akışa anında yansır),
 * ardından (Kaplan hariç) havuzda USDT cinsinden balina hamlesi yapar.
 * Hamleler kullanıcı bakiyelerine DOKUNMAZ; fiyat/grafik/piyasa listesi
 * gerçek takastaki gibi güncellenir.
 */

export interface BotActionResult {
  bot: string
  postId: string
  trade: VirtualTradeResult | null
  summary: string
}

function randomIn(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}`
}

/**
 * Bot hacim dengesi: sığ havuzda sabit balina tutarı fahiş kayma (slippage)
 * üretip masum kullanıcıları likide ederdi. İstenen tutar, havuz USDT
 * rezervinin `botMaxPoolFraction` oranıyla (varsayılan %2, DB `risk_config`
 * ile ayarlanır) sınırlanır — derin havuzda tam, sığ havuzda orantılı hamle.
 */
export async function scaleBotAmount(
  symbol: string,
  requestedUsdt: number,
): Promise<{ amount: number; scaled: boolean }> {
  const key = symbol.trim().toUpperCase()
  if (!Number.isFinite(requestedUsdt) || requestedUsdt <= 0) {
    throw new Error('Geçersiz tutar.')
  }
  const [{ botMaxPoolFraction }, coins] = await Promise.all([
    getRiskParams(),
    listVirtualCoins().catch(() => []),
  ])
  const pool = coins.find((c) => c.symbol.toUpperCase() === key)
  if (!pool || !(pool.reserveUsdt > 0)) return { amount: requestedUsdt, scaled: false }
  const cap = pool.reserveUsdt * botMaxPoolFraction
  if (cap <= 0) return { amount: requestedUsdt, scaled: false }
  if (requestedUsdt <= cap) return { amount: requestedUsdt, scaled: false }
  return { amount: cap, scaled: true }
}

/** Elon Musk → SVGCOIN: hype + 50.000 USDT alım (havuza göre ölçeklenir). */
export async function triggerElonMusk(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'Elon Musk',
    'SVG aya çıkıyor! 🚀',
    randomIn(1500, 2000),
  )
  const { amount, scaled } = await scaleBotAmount('SVGC', 50000)
  const trade = await executeBotPoolTrade('SVGC', 'buy', amount)
  return {
    bot: 'Elon Musk',
    postId: post.id,
    trade,
    summary: `SVGCOIN +${formatNum(trade.tokenAmount)} alım · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
}

/** Faik Erdem (iyi) → ENTES: kurumsal haber + 500.000 USDT alım. */
export async function triggerFaikErdemGood(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'Faik Erdem',
    'ÖNEMLİ: Faik Erdem, ENTES ekosistemine 500.000 USDT stratejik yatırım yaptığını duyurdu. Uzun vadeli güvenoyu. Kurumsal ilgi artıyor.',
    randomIn(800, 1200),
  )
  const { amount, scaled } = await scaleBotAmount('ENTES', 500000)
  const trade = await executeBotPoolTrade('ENTES', 'buy', amount)
  return {
    bot: 'Faik Erdem',
    postId: post.id,
    trade,
    summary: `ENTES +${formatNum(trade.tokenAmount)} alım · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
}

/** Faik Erdem (ters köşe) → ENTES: övgü + 500.000 USDT'lik DUMP. */
export async function triggerFaikErdemBad(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'Faik Erdem',
    'ENTES harika gidiyor, herkes almalı! 🚀🚀🚀',
    randomIn(800, 1200),
  )
  const { amount, scaled } = await scaleBotAmount('ENTES', 500000)
  const trade = await executeBotPoolTrade('ENTES', 'sell', amount)
  return {
    bot: 'Faik Erdem',
    postId: post.id,
    trade,
    summary: `ENTES ${formatNum(trade.tokenAmount)} SATIŞ (dump) · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
}

/** İlham Memiş → V-XAU: güvenli liman çağrısı + 200.000 USDT altın alımı. */
export async function triggerIlhamMemis(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'İlham Memiş',
    'Dikkat: Kripto çöküyor, altına geçin. V-XAU güvenli limandır. Yıllardır söylüyorum, yine haklı çıkacağım.',
    randomIn(1000, 1500),
  )
  const { amount, scaled } = await scaleBotAmount('V-XAU', 200000)
  const trade = await executeBotPoolTrade('V-XAU', 'buy', amount)
  return {
    bot: 'İlham Memiş',
    postId: post.id,
    trade,
    summary: `V-XAU +${formatNum(trade.tokenAmount)} alım · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
}

/** Kripto Kaplanı → sıfır piyasa etkisi, sadece forum mesajı. */
export async function triggerKriptoKaplani(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'Kripto Kaplanı',
    'Ben demiştim, yine kazandırdım 😎',
    randomIn(300, 600),
  )
  return {
    bot: 'Kripto Kaplanı',
    postId: post.id,
    trade: null,
    summary: 'Piyasaya etki yok — yalnızca mesaj yayınlandı.',
  }
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6
  return n.toLocaleString('tr-TR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export const BOT_DEFINITIONS = [
  {
    id: 'elon',
    name: 'Elon Musk',
    target: 'SVGC · 50.000 USDT ALIM (ölçekli)',
    description: 'Hype mesajı + havuz derinliğine göre ölçeklenen alım. Sığ havuzda kayma sınırlanır.',
    run: triggerElonMusk,
  },
  {
    id: 'faik-good',
    name: 'Faik Erdem (Yatırım)',
    target: 'ENTES · 500.000 USDT ALIM (ölçekli)',
    description: 'Kurumsal yatırım haberi + havuz derinliğine göre ölçeklenen alım.',
    run: triggerFaikErdemGood,
  },
  {
    id: 'faik-bad',
    name: 'Faik Erdem (Ters Köşe)',
    target: 'ENTES · 500.000 USDT SATIŞ (ölçekli)',
    description: 'Övgü mesajı + ölçeklenen dump. Fiyat düşer, mesaj yükselir.',
    run: triggerFaikErdemBad,
  },
  {
    id: 'ilham',
    name: 'İlham Memiş',
    target: 'V-XAU · 200.000 USDT ALIM (ölçekli)',
    description: 'Güvenli liman çağrısı + ölçeklenen sanal altın alımı.',
    run: triggerIlhamMemis,
  },
  {
    id: 'kaplan',
    name: 'Kripto Kaplanı',
    target: 'İŞLEMSİZ',
    description: 'Piyasaya sıfır etki — yalnızca forum mesajı.',
    run: triggerKriptoKaplani,
  },
] as const
