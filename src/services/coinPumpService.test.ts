import { beforeEach, describe, expect, it } from 'vitest'
import { quoteVirtualBuy, quoteVirtualSellForUsdt } from '@/engine/virtualAmm'
import {
  computeNewsPumpAmount,
  NEWS_PUMP_TARGET_PCT,
  pumpCoinWithNews,
} from '@/services/coinPumpService'
import { listVirtual24hChanges } from '@/services/virtualMarketService'
import { listForumPosts } from '@/services/forumService'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_admin', username: 'superadmin', email: 'a@x.com', createdAt: 1 }),
  )
})

describe('computeNewsPumpAmount (hedef ~%1.8)', () => {
  it('hedef yüzde varsayılanı 1.8dir', () => {
    expect(NEWS_PUMP_TARGET_PCT).toBe(1.8)
  })

  it('alış tutarı AMM etkisini hedefe oturtur', () => {
    const R = 1_000_000
    const amount = computeNewsPumpAmount(R, 'up')
    expect(amount).toBeGreaterThan(0)
    expect(amount).toBeLessThan(R * 0.02)
    const q = quoteVirtualBuy({ symbol: 'T', reserveUsdt: R, reserveToken: 100_000_000 }, amount)
    expect(q.priceImpactPct).toBeGreaterThan(1.7)
    expect(q.priceImpactPct).toBeLessThan(1.9)
  })

  it('satış tutarı AMM etkisini hedefe oturtur', () => {
    const R = 1_000_000
    const amount = computeNewsPumpAmount(R, 'down')
    expect(amount).toBeGreaterThan(0)
    expect(amount).toBeLessThan(R * 0.02)
    const q = quoteVirtualSellForUsdt({ symbol: 'T', reserveUsdt: R, reserveToken: 100_000_000 }, amount)
    expect(q.priceImpactPct).toBeLessThan(-1.7)
    expect(q.priceImpactPct).toBeGreaterThan(-1.9)
  })

  it('geçersiz girdileri reddeder', () => {
    expect(() => computeNewsPumpAmount(0, 'up')).toThrow()
    expect(() => computeNewsPumpAmount(1000, 'up', 0)).toThrow()
    expect(() => computeNewsPumpAmount(1000, 'up', 25)).toThrow()
  })

  it('özel etki yüzdesi hedefe oturur (örn. %5)', () => {
    const R = 1_000_000
    const amount = computeNewsPumpAmount(R, 'up', 5)
    const q = quoteVirtualBuy({ symbol: 'T', reserveUsdt: R, reserveToken: 100_000_000 }, amount)
    expect(q.priceImpactPct).toBeGreaterThan(4.7)
    expect(q.priceImpactPct).toBeLessThan(5.3)
    const base = computeNewsPumpAmount(R, 'up', NEWS_PUMP_TARGET_PCT)
    expect(amount).toBeGreaterThan(base)
  })
})

describe('pumpCoinWithNews (haber → forum → fiyat)', () => {
  it('sanal coinde haberi foruma düşürüp fiyatı ~%1.8 oynatır', async () => {
    const res = await pumpCoinWithNews('SVGC', 'up', 'Dev ortaklık', 'SVG ekosistemine büyük yatırım geldi.')
    expect(res.impactPct).not.toBeNull()
    expect(Math.abs(res.impactPct!)).toBeGreaterThan(1.5)
    expect(Math.abs(res.impactPct!)).toBeLessThan(2.1)
    const posts = await listForumPosts()
    const post = posts.find((p) => p.id === res.forumPostId)!
    expect(post.content).toContain('Dev ortaklık')
    expect(post.content).toContain('SVGC')
    expect(res.summary).toContain('SVGC')
  })

  it('düşüş yönü fiyatı aşağı iter', async () => {
    const res = await pumpCoinWithNews('SVGC', 'down', 'Kötü bilanço', 'Beklentiler tutmadı.')
    expect(res.impactPct!).toBeLessThan(-1.5)
    expect(res.impactPct!).toBeGreaterThan(-2.1)
  })

  it('gerçek piyasa sembolünde fiyat adımı atmadan haber+forum yayınlar', async () => {
    const res = await pumpCoinWithNews('BTCUSDT', 'up', 'ETF onayı', 'Kurumsal ilgi artıyor.')
    expect(res.trade).toBeNull()
    expect(res.impactPct).toBeNull()
    const posts = await listForumPosts()
    expect(posts.find((p) => p.id === res.forumPostId)!.content).toContain('ETF onayı')
  })

  it('boş haberi reddeder, havuza dokunmaz', async () => {
    await expect(pumpCoinWithNews('SVGC', 'up', '   ', 'metin')).rejects.toThrow()
    await expect(pumpCoinWithNews('SVGC', 'up', 'başlık', '')).rejects.toThrow()
  })

  it('özel etkiyle haberi foruma düşürüp fiyatı hedefe oynatır', async () => {
    const res = await pumpCoinWithNews('SVGC', 'up', 'Özel etki', 'Hedef %5 denemesi.', 'normal', 5)
    expect(res.targetPct).toBe(5)
    expect(res.impactPct!).toBeGreaterThan(4.5)
    expect(res.impactPct!).toBeLessThan(5.5)
  })
})

describe('listVirtual24hChanges (çevrimdışı)', () => {
  it('yerel modda boş döner', async () => {
    await expect(listVirtual24hChanges()).resolves.toEqual({})
  })
})
