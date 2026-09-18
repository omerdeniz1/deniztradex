import { beforeEach, describe, expect, it } from 'vitest'
import {
  runCharacterBot,
  triggerElonMusk,
  triggerEntesYoneticisiBad,
  triggerEntesYoneticisiGood,
  triggerIlhamMemis,
  triggerKriptoKaplani,
} from '@/services/botSimulationService'
import { listForumPosts } from '@/services/forumService'
import { listVirtualCoins } from '@/services/virtualMarketService'
import { useTradeStore } from '@/store/tradeStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  // Botlar oturum ister (yerel modda bakiye/havuz güncellemesi oturumsuz da
  // çalışır ama servis kapısı oturum arar).
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_admin', username: 'superadmin', email: 'a@x.com', createdAt: 1 }),
  )
})

async function priceOf(symbol: string): Promise<number> {
  const coins = await listVirtualCoins()
  return coins.find((c) => c.symbol === symbol)!.price
}

describe('botSimulationService (yerel motor)', () => {
  it('Elon Musk: hype mesajı + SVGC alımı fiyatı yukarı iter', async () => {
    const before = await priceOf('SVGC')
    const res = await triggerElonMusk()

    expect(res.trade).not.toBeNull()
    expect(res.trade!.priceImpactPct).toBeGreaterThan(0)
    const posts = await listForumPosts()
    const post = posts.find((p) => p.id === res.postId)!
    expect(post).toMatchObject({ verifiedTier: 'admin', avatarUrl: null })
    expect(post.content).toContain('SVG aya çıkıyor')
    expect(post.likeCount).toBeGreaterThanOrEqual(1500)
    expect(post.likeCount).toBeLessThanOrEqual(2000)
    expect(await priceOf('SVGC')).toBeGreaterThan(before)
    // Kullanıcı bakiyesine dokunulmaz.
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('Entes Yöneticisi iyi: sahip ağzından kâr açıklaması + ENTES alımı', async () => {
    const before = await priceOf('ENTES')
    const res = await triggerEntesYoneticisiGood()

    expect(res.trade!.priceImpactPct).toBeGreaterThan(0)
    const posts = await listForumPosts()
    const post = posts.find((p) => p.id === res.postId)!
    expect(post.content).toContain('Entes Yöneticisi')
    expect(post.content).not.toContain('Erdem Holding')
    // Sahip "yatırım yaptım" demez, kâr/ekosistem açıklar.
    expect(post.content).not.toContain('yatırım yaptığını duyurdu')
    expect(post).toMatchObject({ verifiedTier: 'admin', avatarUrl: null })
    expect(await priceOf('ENTES')).toBeGreaterThan(before)
  })

  it('Entes Yöneticisi dengeleme: sahip uyarısı + satış (fiyat düşer)', async () => {
    const before = await priceOf('ENTES')
    const res = await triggerEntesYoneticisiBad()

    expect(res.trade!.priceImpactPct).toBeLessThan(0)
    const posts = await listForumPosts()
    const badPost = posts.find((p) => p.id === res.postId)!
    expect(badPost.content).toContain('Entes Yöneticisi')
    expect(badPost.content).not.toContain('herkes almalı')
    expect(badPost).toMatchObject({ verifiedTier: 'admin', avatarUrl: null })
    expect(await priceOf('ENTES')).toBeLessThan(before)
  })

  it('runCharacterBot: istenen sanal coin + yönde çalışır (emtia dahil)', async () => {
    const before = await priceOf('V-XAG')
    const res = await runCharacterBot('ilham', 'V-XAG', 'up')

    expect(res.trade!.priceImpactPct).toBeGreaterThan(0)
    expect(await priceOf('V-XAG')).toBeGreaterThan(before)
    const down = await runCharacterBot('elon', 'RGC', 'down')
    expect(down.trade!.priceImpactPct).toBeLessThan(0)
  })

  it('İlham Memiş: altın çağrısı + V-XAU alımı', async () => {
    const before = await priceOf('V-XAU')
    const res = await triggerIlhamMemis()

    expect(res.trade!.priceImpactPct).toBeGreaterThan(0)
    const posts = await listForumPosts()
    const goldPost = posts.find((p) => p.id === res.postId)!
    expect(goldPost.content).toContain('altına geçin')
    expect(goldPost).toMatchObject({ verifiedTier: 'admin', avatarUrl: null })
    expect(await priceOf('V-XAU')).toBeGreaterThan(before)
  })

  it('Kripto Kaplanı: yalnız mesaj, piyasaya sıfır etki', async () => {
    const pricesBefore = await Promise.all(
      ['ENTES', 'SVGC', 'V-XAU'].map((s) => priceOf(s)),
    )
    const res = await triggerKriptoKaplani()

    expect(res.trade).toBeNull()
    const posts = await listForumPosts()
    const kaplanPost = posts.find((p) => p.id === res.postId)!
    expect(kaplanPost.content).toContain('Ben demiştim')
    expect(kaplanPost).toMatchObject({ verifiedTier: 'admin', avatarUrl: null })
    const pricesAfter = await Promise.all(
      ['ENTES', 'SVGC', 'V-XAU'].map((s) => priceOf(s)),
    )
    expect(pricesAfter).toEqual(pricesBefore)
  })
})
