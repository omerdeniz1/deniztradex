import { beforeEach, describe, expect, it } from 'vitest'
import { useDnzStore } from '@/store/dnzStore'
import { DNZ_SEED_PRICE } from '@/services/dnzService'

/** Supabase yapılandırılmamış test ortamı → store tamamen yerel çalışır. */
beforeEach(() => {
  localStorage.clear()
  useDnzStore.getState().resetDnz()
})

describe('dnzStore', () => {
  it('tohum fiyatla başlar, tercihi hatırlar', () => {
    const s = useDnzStore.getState()
    expect(s.balance).toBe(0)
    expect(s.price).toBe(DNZ_SEED_PRICE)
    expect(s.payWithDnz).toBe(false)
    s.setPayWithDnz(true)
    expect(useDnzStore.getState().payWithDnz).toBe(true)
  })

  it('alış bakiyeyi ve ortalama maliyeti günceller', () => {
    const s = useDnzStore.getState()
    expect(s.buyDnz({ qty: 10, price: 0.5, usdtCost: 5 })).toEqual({ ok: true })
    expect(s.buyDnz({ qty: 10, price: 1.0, usdtCost: 10 })).toEqual({ ok: true })
    const after = useDnzStore.getState()
    expect(after.balance).toBeCloseTo(20)
    expect(after.avgCost).toBeCloseTo(0.75)
    expect(after.ledger[0].type).toBe('buy')
  })

  it('satış bakiyeyi düşer, karşılığı döndürür, yetersizde reddeder', () => {
    const s = useDnzStore.getState()
    s.buyDnz({ qty: 10, price: 0.5, usdtCost: 5 })
    const res = useDnzStore.getState().sellDnz({ qty: 4, price: 1.0 })
    expect(res).toEqual({ ok: true, proceeds: 4 })
    expect(useDnzStore.getState().balance).toBeCloseTo(6)
    expect(useDnzStore.getState().sellDnz({ qty: 99, price: 1 }).ok).toBe(false)
  })

  it('komisyon kesintisi bakiyeden düşer, yetmezse false döner', () => {
    const s = useDnzStore.getState()
    expect(s.deductFeeDnz(1)).toBe(false)
    s.buyDnz({ qty: 10, price: 0.5, usdtCost: 5 })
    expect(useDnzStore.getState().deductFeeDnz(1.5, { symbol: 'BTCUSDT' })).toBe(true)
    const after = useDnzStore.getState()
    expect(after.balance).toBeCloseTo(8.5)
    expect(after.ledger[0].type).toBe('fee_discount')
  })

  it('tick fiyatı deterministik ilerletir', () => {
    const s = useDnzStore.getState()
    const t0 = Date.UTC(2026, 0, 1)
    s.tick(t0)
    const p1 = useDnzStore.getState().price
    s.tick(t0)
    expect(useDnzStore.getState().price).toBe(p1)
    s.tick(t0 + 60 * 60 * 1000)
    expect(useDnzStore.getState().priceStep).toBeGreaterThan(0)
  })
})
