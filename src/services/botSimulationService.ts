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

/**
 * Bot gönderisi sahte beğeni bandı: 20B–180B arası uniform rastgele.
 * Forumda `formatLikeCount` ile "20B"–"180B" görünür. Bant tek merkezden
 * yönetilir — tüm karakter botları aynı vitrin aralığını kullanır.
 */
export const BOT_LIKES_MIN = 20000
export const BOT_LIKES_MAX = 180000

export function randomBotLikes(): number {
  return randomIn(BOT_LIKES_MIN, BOT_LIKES_MAX)
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
    randomBotLikes(),
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

/** Entes Yöneticisi (iyi) → ENTES: SAHİP ağzından kâr açıklaması + 500.000 USDT alım. */
export async function triggerEntesYoneticisiGood(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'Entes Yöneticisi',
    pick(ENTES_YONETICI_UP_POSTS),
    randomBotLikes(),
  )
  const { amount, scaled } = await scaleBotAmount('ENTES', 500000)
  const trade = await executeBotPoolTrade('ENTES', 'buy', amount)
  return {
    bot: 'Entes Yöneticisi',
    postId: post.id,
    trade,
    summary: `ENTES +${formatNum(trade.tokenAmount)} alım · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
}

/** Entes Yöneticisi (dengeleme) → ENTES: sahip ağzından temkinli açıklama + 500.000 USDT'lik SATIŞ. */
export async function triggerEntesYoneticisiBad(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'Entes Yöneticisi',
    pick(ENTES_YONETICI_DOWN_POSTS),
    randomBotLikes(),
  )
  const { amount, scaled } = await scaleBotAmount('ENTES', 500000)
  const trade = await executeBotPoolTrade('ENTES', 'sell', amount)
  return {
    bot: 'Entes Yöneticisi',
    postId: post.id,
    trade,
    summary: `ENTES ${formatNum(trade.tokenAmount)} SATIŞ (dengeleme) · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
}

/** İlham Memiş → V-XAU: güvenli liman çağrısı + 200.000 USDT altın alımı. */
export async function triggerIlhamMemis(): Promise<BotActionResult> {
  const post = await createBotForumPost(
    'İlham Memiş',
    'Dikkat: Kripto çöküyor, altına geçin. V-XAU güvenli limandır. Yıllardır söylüyorum, yine haklı çıkacağım.',
    randomBotLikes(),
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
    randomBotLikes(),
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

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------
// Karakter gönderi havuzları — Entes Yöneticisi ENTES'in SAHİBİDİR:
// "yatırım yaptım" değil, kâr/bilanço/ekosistem açıklaması yapar.
// ---------------------------------------------------------------

const ENTES_YONETICI_UP_POSTS = [
  'Entes Yöneticisi duyurdu: ENTES 3. çeyrekte net kâr açıkladı. Ekosistem gelirleri bir önceki çeyreğe göre arttı, yeni yol haritası yakında paylaşılacak.',
  'Entes Yöneticisi paylaştı: ENTES ekosistem raporu yayında — aktif cüzdan sayısı ve işlem hacmi büyümeye devam ediyor. Ekip olarak geliştirmeye tam gaz devam ediyoruz.',
  'Entes Yöneticisi: ENTES hazinesi güçlendi, geri alım programı planlandığı gibi sürüyor. Uzun vadeli yatırımcımıza teşekkürler.',
] as const

const ENTES_YONETICI_DOWN_POSTS = [
  'Entes Yöneticisi uyarıyor: ENTES tarafında kısa vadeli kâr realizasyonu görebiliriz. Ekip olarak piyasa yapıcı dengeleme adımları atıyoruz, panik yok.',
  'Entes Yöneticisi duyurdu: hazine optimizasyonu kapsamında sınırlı, planlı satış yapılacaktır. Bu bir dengeleme hamlesidir, ENTES ekosistem hedefleri değişmedi.',
] as const

const ELON_UP_POSTS = [
  'SVG aya çıkıyor! 🚀',
  'SVGCOIN grafiği alev alıyor, kemerleri bağlayın! 🚀',
] as const

const ELON_DOWN_POSTS = [
  'SVG biraz ısındı, kâr almayı unutmayın. Düzeltme sağlıklıdır.',
  'Piyasada dalgalanma var, SVG tarafında temkinli olun.',
] as const

const ILHAM_UP_POSTS = [
  'Dikkat: Kripto çöküyor, altına geçin. V-XAU güvenli limandır. Yıllardır söylüyorum, yine haklı çıkacağım.',
  'Belirsizlik dönemlerinde fiziki karşılıklı sanal altın güçlü durur. V-XAU tarafı izlenmeli.',
] as const

const ILHAM_DOWN_POSTS = [
  'Altın bir miktar geri çekilebilir, kademeli alım fırsatı doğar. V-XAU izlenmeli.',
  'Kısa vadede kâr realizasyonu normaldir, güvenli liman hikâyesi değişmedi.',
] as const

const KAPLAN_POSTS = [
  'Ben demiştim, yine kazandırdım 😎',
  'Grafiğe bakın, formasyon tıkır tıkır işliyor. Kaplan yanılmaz 😎',
] as const

export type BotDirection = 'up' | 'down'

export interface CharacterBotConfig {
  id: string
  name: string
  /** Varsayılan hedef (panelde değiştirilebilir). */
  defaultCoin: string
  /** Hamle büyüklüğü (USDT). 0 = işlemsiz (yalnızca mesaj). */
  tradeUsdt: number
  description: string
}

export const CHARACTER_BOTS: CharacterBotConfig[] = [
  {
    id: 'elon',
    name: 'Elon Musk',
    defaultCoin: 'SVGC',
    tradeUsdt: 50000,
    description: 'Hype / temkin mesajı + ölçeklenen havuz hamlesi.',
  },
  {
    id: 'entes',
    name: 'Entes Yöneticisi',
    defaultCoin: 'ENTES',
    tradeUsdt: 500000,
    description: 'Sahip ağzından kâr/ekosistem açıklaması + ölçeklenen hamle.',
  },
  {
    id: 'ilham',
    name: 'İlham Memiş',
    defaultCoin: 'V-XAU',
    tradeUsdt: 200000,
    description: 'Güvenli liman çağrısı + ölçeklenen sanal emtia hamlesi.',
  },
  {
    id: 'kaplan',
    name: 'Kripto Kaplanı',
    defaultCoin: 'ENTES',
    tradeUsdt: 0,
    description: 'Piyasaya sıfır etki — yalnızca forum mesajı.',
  },
]

/**
 * Karakter botunu İSTENEN coin + yönde çalıştır: önce personaya uygun
 * forum gönderisi, sonra (Kaplan hariç) havuzda USDT hamlesi.
 * Tüm sanal coinler + emtialar hedef seçilebilir; tutar havuz
 * derinliğine göre ölçeklenir, kullanıcı bakiyelerine dokunulmaz.
 */
export async function runCharacterBot(
  botId: string,
  rawSymbol: string,
  direction: BotDirection,
): Promise<BotActionResult> {
  const symbol = rawSymbol.trim().toUpperCase()
  if (!symbol) throw new Error('Geçersiz sembol.')
  const up = direction === 'up'
  const side = up ? 'buy' : 'sell'

  const message =
    botId === 'elon'
      ? pick(up ? ELON_UP_POSTS : ELON_DOWN_POSTS)
      : botId === 'entes'
        ? pick(up ? ENTES_YONETICI_UP_POSTS : ENTES_YONETICI_DOWN_POSTS)
        : botId === 'ilham'
          ? pick(up ? ILHAM_UP_POSTS : ILHAM_DOWN_POSTS)
          : botId === 'kaplan'
            ? `${pick(KAPLAN_POSTS)} (${symbol})`
            : null
  if (message === null) throw new Error('Bilinmeyen bot.')

  const botName =
    botId === 'entes' ? 'Entes Yöneticisi' : CHARACTER_BOTS.find((b) => b.id === botId)?.name ?? botId
  const post = await createBotForumPost(botName, message, randomBotLikes())

  const cfg = CHARACTER_BOTS.find((b) => b.id === botId)
  if (!cfg || cfg.tradeUsdt <= 0) {
    return { bot: botName, postId: post.id, trade: null, summary: 'Piyasaya etki yok — yalnızca mesaj yayınlandı.' }
  }
  const { amount, scaled } = await scaleBotAmount(symbol, cfg.tradeUsdt)
  const trade = await executeBotPoolTrade(symbol, side, amount)
  const dirWord = up ? 'alım' : 'SATIŞ (dengeleme)'
  return {
    bot: botName,
    postId: post.id,
    trade,
    summary: `${symbol} ${up ? '+' : ''}${formatNum(trade.tokenAmount)} ${dirWord} · fiyat etkisi %${fmtPct(trade.priceImpactPct)}${scaled ? ' (havuz derinliğine göre ölçeklendi)' : ''}`,
  }
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
    id: 'entes-good',
    name: 'Entes Yöneticisi (Yatırım)',
    target: 'ENTES · 500.000 USDT ALIM (ölçekli)',
    description: 'Sahip ağzından kâr açıklaması + havuz derinliğine göre ölçeklenen alım.',
    run: triggerEntesYoneticisiGood,
  },
  {
    id: 'entes-bad',
    name: 'Entes Yöneticisi (Dengeleme)',
    target: 'ENTES · 500.000 USDT SATIŞ (ölçekli)',
    description: 'Sahip uyarısı + ölçeklenen dengeleme satışı. Fiyat düşer.',
    run: triggerEntesYoneticisiBad,
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
