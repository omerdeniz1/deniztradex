import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  nextRetailDelayMs,
  pickRetailCoin,
  pickRetailSide,
  retailOrderSize,
  retailTickOnce,
  startRetailBot,
  stopRetailBot,
  isRetailBotRunning,
  getRetailBotStatus,
  onRetailTrade,
  resetRetailBotStats,
  RETAIL_MIN_DELAY_MS,
  RETAIL_MAX_DELAY_MS,
  RETAIL_MIN_USD,
  RETAIL_HARD_CAP_USD,
  type RetailPrint,
} from '@/services/retailBotService'
import { useRetailFeed } from '@/hooks/useRetailFeed'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore } from '@/store/dnzStore'
import { VIRTUAL_SEED } from '@/services/virtualMarketService'

/** Deterministik RNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_bot', username: 'botcu', email: 'b@x.com', createdAt: 1 }),
  )
  useTradeStore.getState().resetWallet()
  useDnzStore.getState().resetDnz()
  stopRetailBot()
  resetRetailBotStats()
})

afterEach(() => {
  stopRetailBot()
  vi.useRealTimers()
})

describe('retail zamanlama + seçim (saf fonksiyonlar)', () => {
  it('gecikme 2–7 sn bandındadır', () => {
    const rng = seeded(7)
    for (let i = 0; i < 500; i++) {
      const d = nextRetailDelayMs(rng)
      expect(d).toBeGreaterThanOrEqual(RETAIL_MIN_DELAY_MS)
      expect(d).toBeLessThanOrEqual(RETAIL_MAX_DELAY_MS)
    }
  })

  it('yön ~%50 alım / %50 satım dağılır', () => {
    const rng = seeded(21)
    let buys = 0
    const n = 1000
    for (let i = 0; i < n; i++) if (pickRetailSide(rng) === 'buy') buys++
    expect(buys).toBeGreaterThan(n * 0.4)
    expect(buys).toBeLessThan(n * 0.6)
  })

  it('tutar perakende bandında ve havuza göre ölçeklenir', () => {
    const rng = seeded(99)
    // Referans altı havuz (100B$): tam 10–150$ bandı.
    for (let i = 0; i < 200; i++) {
      const a = retailOrderSize(100_000, rng)
      expect(a).toBeGreaterThanOrEqual(10)
      expect(a).toBeLessThanOrEqual(150)
    }
    // Sığ havuz (500B$): ×2 ölçek → 20–300$.
    for (let i = 0; i < 200; i++) {
      const a = retailOrderSize(500_000, rng)
      expect(a).toBeGreaterThanOrEqual(20)
      expect(a).toBeLessThanOrEqual(300)
    }
    // DNZ havuzu (2M$): ×8 ölçek → 80–1200$.
    for (let i = 0; i < 200; i++) {
      const a = retailOrderSize(2_000_000, rng)
      expect(a).toBeGreaterThanOrEqual(80)
      expect(a).toBeLessThanOrEqual(1200)
    }
    // Derin havuz (50M$): tavan 5000$ aşılmaz.
    for (let i = 0; i < 200; i++) {
      const a = retailOrderSize(50_000_000, rng)
      expect(a).toBeGreaterThanOrEqual(2000)
      expect(a).toBeLessThanOrEqual(RETAIL_HARD_CAP_USD)
    }
  })

  it('coin seçimi listeden yapar, boş/geçersizi eleer', () => {
    expect(pickRetailCoin([], seeded(1))).toBeNull()
    const c = pickRetailCoin([...VIRTUAL_SEED], seeded(5))
    expect(c).not.toBeNull()
    expect(VIRTUAL_SEED.map((s) => s.symbol)).toContain(c!.symbol)
    // DNZ tohumda mevcuttur.
    expect(VIRTUAL_SEED.map((s) => s.symbol)).toContain('DNZ')
  })
})

describe('retail motor döngüsü', () => {
  it('start idempotenttir, stop durdurur', () => {
    vi.useFakeTimers()
    expect(startRetailBot()).toBe(true)
    expect(startRetailBot()).toBe(false)
    expect(isRetailBotRunning()).toBe(true)
    stopRetailBot()
    expect(isRetailBotRunning()).toBe(false)
  })

  it('tek baskı havuzu oynatır ve yayınlar (yerel)', async () => {
    const seen: RetailPrint[] = []
    const unsub = onRetailTrade((p) => seen.push(p))
    const print = await retailTickOnce()
    expect(print).not.toBeNull()
    expect(print!.usdt).toBeGreaterThanOrEqual(RETAIL_MIN_USD)
    expect(Number.isFinite(print!.priceImpactPct)).toBe(true)
    // Yön işareti: alış fiyatı yukarı, satış aşağı iter.
    if (print!.side === 'buy') expect(print!.priceImpactPct).toBeGreaterThan(0)
    else expect(print!.priceImpactPct).toBeLessThan(0)
    expect(seen).toHaveLength(1)
    expect(getRetailBotStatus().trades).toBe(1)
    unsub()
  })

  it('oturumsuz baskı atlanır (sayaç artar, hata yok)', async () => {
    localStorage.removeItem('deniztradx_session')
    const print = await retailTickOnce()
    expect(print).toBeNull()
    expect(getRetailBotStatus().skipped).toBe(1)
    expect(getRetailBotStatus().errors).toBe(0)
  })

  it('zamanlayıcı döngüsü baskı üretir (sahte saat)', async () => {
    vi.useFakeTimers()
    startRetailBot()
    await vi.advanceTimersByTimeAsync(60000)
    expect(getRetailBotStatus().trades).toBeGreaterThan(0)
    expect(isRetailBotRunning()).toBe(true)
  })
})

describe('useRetailFeed', () => {
  it('baskıları yeniden eskiye listeler', async () => {
    const { result } = renderHook(() => useRetailFeed(5))
    expect(result.current).toHaveLength(0)
    await act(async () => {
      await retailTickOnce()
      await retailTickOnce()
    })
    expect(result.current).toHaveLength(2)
    expect(result.current[0].at).toBeGreaterThanOrEqual(result.current[1].at)
  })
})
