import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDnzTrade } from '@/hooks/useDnzTrade'
import { useDnzStore } from '@/store/dnzStore'
import { useTradeStore } from '@/store/tradeStore'
import { dnzStepForTs } from '@/services/dnzService'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useDnzStore.getState().resetDnz()
  // Fiyatı sabitle: tick() no-op olur, hesaplar deterministik kalır.
  useDnzStore.setState({ price: 0.5, priceStep: dnzStepForTs(Date.now()) })
})

describe('useDnzTrade', () => {
  it('USDT ile DNZ alır: iki bacak birlikte işlenir', () => {
    const { result } = renderHook(() => useDnzTrade())
    useTradeStore.getState().deposit(1000)
    const res = result.current.buyForUsdt(100)
    expect(res.ok).toBe(true)
    expect(useDnzStore.getState().balance).toBeCloseTo(200)
    expect(useTradeStore.getState().balance).toBeCloseTo(900)
    expect(useDnzStore.getState().ledger[0]).toMatchObject({ type: 'buy', amountDnz: 200 })
  })

  it('DNZ satar: USDT karşılığı cüzdana geçer', () => {
    const { result } = renderHook(() => useDnzTrade())
    useTradeStore.getState().deposit(1000)
    result.current.buyForUsdt(100)
    const res = result.current.sellQty(50)
    expect(res.ok).toBe(true)
    expect(useDnzStore.getState().balance).toBeCloseTo(150)
    expect(useTradeStore.getState().balance).toBeCloseTo(925)
  })

  it('yetersiz bakiyelerde reddeder, yarım işlem bırakmaz', () => {
    const { result } = renderHook(() => useDnzTrade())
    useTradeStore.getState().deposit(10)
    const buy = result.current.buyForUsdt(100)
    expect(buy.ok).toBe(false)
    expect(useDnzStore.getState().balance).toBe(0)
    expect(useTradeStore.getState().balance).toBeCloseTo(10)
    const sell = result.current.sellQty(5)
    expect(sell.ok).toBe(false)
  })

  it('geçersiz tutarları reddeder', () => {
    const { result } = renderHook(() => useDnzTrade())
    expect(result.current.buyForUsdt(0).ok).toBe(false)
    expect(result.current.sellQty(-1).ok).toBe(false)
  })
})
