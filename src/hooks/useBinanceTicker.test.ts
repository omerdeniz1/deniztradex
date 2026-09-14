import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useBinanceTicker } from '@/hooks/useBinanceTicker'
import { MockWebSocket } from '@/test/setup'

beforeEach(() => {
  MockWebSocket.reset()
})

describe('useBinanceTicker', () => {
  it('connects and reports live ticker prices from the socket', () => {
    const { result } = renderHook(() => useBinanceTicker('BTCUSDT'))

    act(() => {
      MockWebSocket.openAll()
    })

    expect(result.current.status).toBe('connected')

    act(() => {
      MockWebSocket.emit(undefined, {
        e: '24hrTicker',
        s: 'BTCUSDT',
        c: '65432.10',
        p: '134.20',
        P: '0.21',
        v: '12000.5',
      })
    })

    expect(result.current.ticker).toEqual({
      symbol: 'BTCUSDT',
      price: 65432.1,
      change24h: 134.2,
      changePercent24h: 0.21,
      volume24h: 12000.5,
    })
  })

  it('ignores malformed or unrelated messages', () => {
    const { result } = renderHook(() => useBinanceTicker('BTCUSDT'))

    act(() => {
      MockWebSocket.emit(undefined, { e: 'other', bad: true })
      MockWebSocket.emit(undefined, '{not valid json')
    })

    expect(result.current.ticker).toBeNull()
  })

  it('marks status disconnected when the socket closes', () => {
    const { result } = renderHook(() => useBinanceTicker('BTCUSDT'))

    act(() => {
      MockWebSocket.openAll()
      const ws = MockWebSocket.instances.at(-1)
      ws?.close()
      ws?.onclose?.()
    })

    expect(result.current.status).toBe('disconnected')
  })
})