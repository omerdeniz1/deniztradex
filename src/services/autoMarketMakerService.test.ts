import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUTO_BOT_REVERT_BAND,
  getAutoBotConfig,
  getLocalAutoBotConfig,
  planAutoTrades,
  runAutoBotTick,
  saveAutoBotConfig,
} from '@/services/autoMarketMakerService'
import { listVirtualCoins } from '@/services/virtualMarketService'

beforeEach(() => {
  localStorage.clear()
})

// Deterministik rastgele: sabit diziyle beslenir.
function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

describe('planAutoTrades', () => {
  it('boş havuzda plan üretmez', () => {
    expect(planAutoTrades([], 'normal')).toEqual([])
  })

  it('yoğunluğa göre 1-5 coin seçer, oranlar cap altındadır', async () => {
    const coins = await listVirtualCoins()
    for (const intensity of ['calm', 'normal', 'lively'] as const) {
      const plans = planAutoTrades(coins, intensity, seq([0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4]))
      expect(plans.length).toBeGreaterThanOrEqual(1)
      expect(plans.length).toBeLessThanOrEqual(5)
      for (const p of plans) {
        expect(p.fraction).toBeGreaterThan(0)
        expect(p.fraction).toBeLessThanOrEqual(0.004)
        expect(['buy', 'sell']).toContain(p.side)
      }
    }
  })

  it('ortalama-dönüş: tavandaki coine satış, diptekine alış baskısı', async () => {
    const coins = await listVirtualCoins()
    const entes = coins.find((c) => c.symbol === 'ENTES')!
    const pumped = [{ ...entes, price: entes.price * (1 + AUTO_BOT_REVERT_BAND + 0.02) }]
    const dipped = [{ ...entes, price: entes.price * (1 - AUTO_BOT_REVERT_BAND - 0.02) }]
    // Tek coinlik havuzda seçim garanti; yön zarı 0..1 uniform süpürür.
    const sweep = Array.from({ length: 20 }, (_, i) => (i + 0.5) / 20)
    let topSells = 0
    let topBuys = 0
    let dipSells = 0
    let dipBuys = 0
    for (const r of sweep) {
      for (const p of planAutoTrades(pumped, 'calm', seq([0.1, r, 0.5]))) {
        if (p.side === 'sell') topSells += 1
        else topBuys += 1
      }
      for (const p of planAutoTrades(dipped, 'calm', seq([0.1, r, 0.5]))) {
        if (p.side === 'sell') dipSells += 1
        else dipBuys += 1
      }
    }
    // Tavan: %70 satış; dip: %70 alış.
    expect(topSells).toBeGreaterThan(topBuys)
    expect(dipBuys).toBeGreaterThan(dipSells)
  })
})

describe('runAutoBotTick (yerel motor, oturumsuz)', () => {
  it('havuzu oynatır, hacmi büyütür, bakiyeye dokunmaz', async () => {
    const before = await listVirtualCoins()
    const volBefore = new Map(before.map((c) => [c.symbol, c.volume24h]))

    const res = await runAutoBotTick('normal')

    expect(res.length).toBeGreaterThanOrEqual(1)
    const after = await listVirtualCoins()
    // En az bir coinin hacmi artmış olmalı
    const grown = after.filter((c) => c.volume24h > (volBefore.get(c.symbol) ?? 0))
    expect(grown.length).toBeGreaterThanOrEqual(1)
    // Hamleler sınırlı: tek tikte fiyat %1'den fazla oynamamalı
    for (const r of res) {
      expect(Math.abs(r.priceImpactPct)).toBeLessThan(1)
      expect(r.usdtAmount).toBeGreaterThan(0)
    }
    // Lively tikte en az 3 hamle beklenir (çalkantı).
    const lively = await runAutoBotTick('lively')
    expect(lively.length).toBeGreaterThanOrEqual(1)
  })

  it('art arda tikler fiyatı tohum bandında tutar (kaçış yok)', async () => {
    for (let i = 0; i < 60; i++) {
      await runAutoBotTick('lively')
    }
    const coins = await listVirtualCoins()
    for (const c of coins) {
      const seed = { ENTES: 10, 'V-XAU': 100, 'V-XAG': 20, RGC: 0.01, MPRC: 0.03, SVGC: 0.005 }[c.symbol] ?? c.price
      const drift = Math.abs((c.price - seed) / seed)
      // 60 sert tikten sonra bile fiyat tohumun 2 katından uzaklaşmamalı
      expect(drift).toBeLessThan(1)
    }
  })
})

describe('auto bot config', () => {
  it('varsayılan açık + 12 sn + normal gelir', () => {
    expect(getLocalAutoBotConfig()).toEqual({ enabled: true, intervalMs: 12000, intensity: 'normal', updatedAt: 0 })
  })

  it('kayıt + aralık kelepçesi (4 sn - 120 sn)', async () => {
    await saveAutoBotConfig({ enabled: false, intervalMs: 1000, intensity: 'lively', updatedAt: 0 })
    const c = getLocalAutoBotConfig()
    expect(c.enabled).toBe(false)
    expect(c.intervalMs).toBe(4000)
    expect(c.intensity).toBe('lively')
    expect(c.updatedAt).toBeGreaterThan(0)
  })

  it('son yazan kazanır: yerel kayıt varsayılanı ezer', async () => {
    await saveAutoBotConfig({ enabled: true, intervalMs: 8000, intensity: 'lively', updatedAt: 0 })
    // Supabase yok (test) → yerel okunur; sayfa geçişinde korunur.
    const again = await getAutoBotConfig()
    expect(again.intervalMs).toBe(8000)
    expect(again.intensity).toBe('lively')
  })
})
