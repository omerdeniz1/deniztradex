import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDnzTrade } from '@/hooks/useDnzTrade'
import { useDnzStore } from '@/store/dnzStore'
import { useTradeStore } from '@/store/tradeStore'

/** Yerel AMM havuzu (tohum DNZ 100M/200M → $0.50) üzerinden takas. */
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'deniztradx_session',
    JSON.stringify({ id: 'u_test', username: 'tester', email: 't@test.co', createdAt: 1 }),
  )
  useTradeStore.getState().resetWallet()
  useDnzStore.getState().resetDnz()
})

describe('useDnzTrade (havuz yerleşimi)', () => {
  it('USDT ile DNZ alır: havuzdan token çıkar, etki fiyata yansır', async () => {
    const { result } = renderHook(() => useDnzTrade())
    useTradeStore.getState().deposit(1000)
    let res
    await act(async () => {
      res = await result.current.buyForUsdt(100)
    })
    expect(res!.ok).toBe(true)
    // %0.3 havuz ücreti + kayma: 200 DNZ'nin biraz altı.
    const dnz = useDnzStore.getState().balance
    expect(dnz).toBeGreaterThan(190)
    expect(dnz).toBeLessThan(200)
    expect(useTradeStore.getState().balance).toBeCloseTo(900)
  })

  it('DNZ satar: USDT karşılığı cüzdana geçer', async () => {
    const { result } = renderHook(() => useDnzTrade())
    useTradeStore.getState().deposit(1000)
    await act(async () => {
      await result.current.buyForUsdt(100)
    })
    const held = useDnzStore.getState().balance
    expect(held).toBeGreaterThan(0)
    let res
    await act(async () => {
      res = await result.current.sellQty(held / 2)
    })
    expect(res!.ok).toBe(true)
    expect(useDnzStore.getState().balance).toBeCloseTo(held / 2, 4)
    expect(useTradeStore.getState().balance).toBeGreaterThan(900)
  })

  it('yetersiz bakiyelerde reddeder, yarım işlem bırakmaz', async () => {
    const { result } = renderHook(() => useDnzTrade())
    useTradeStore.getState().deposit(10)
    let buy
    await act(async () => {
      buy = await result.current.buyForUsdt(100)
    })
    expect(buy!.ok).toBe(false)
    expect(useDnzStore.getState().balance).toBe(0)
    expect(useTradeStore.getState().balance).toBeCloseTo(10)
    let sell
    await act(async () => {
      sell = await result.current.sellQty(5)
    })
    expect(sell!.ok).toBe(false)
  })

  it('geçersiz tutarları reddeder', async () => {
    const { result } = renderHook(() => useDnzTrade())
    let a
    let b
    await act(async () => {
      a = await result.current.buyForUsdt(0)
      b = await result.current.sellQty(-1)
    })
    expect(a!.ok).toBe(false)
    expect(b!.ok).toBe(false)
  })
})
