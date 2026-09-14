import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from '@testing-library/react'
import { useLivePrices, resetLivePriceStream } from '@/hooks/useLivePrices'
import { MockWebSocket } from '@/test/setup'
import { useMarketStore } from '@/store/marketStore'

beforeEach(() => {
  MockWebSocket.reset()
  resetLivePriceStream()
  useMarketStore.getState().resetMarket()
})

afterEach(() => {
  resetLivePriceStream()
})

describe('useLivePrices', () => {
  it('delivers prices into the store from a per-symbol @ticker stream', async () => {
    renderHook(() => useLivePrices(['BTCUSDT']))

    await act(async () => {
      MockWebSocket.openAll()
    })

    act(() => {
      MockWebSocket.emit(undefined, {
        s: 'BTCUSDT',
        c: '70000',
        p: '100',
        P: '0.14',
        v: '4242',
      })
    })

    await vi.waitFor(() => {
      expect(useMarketStore.getState().livePrices.BTCUSDT).toBe(70000)
    })
    expect(useMarketStore.getState().tickers.BTCUSDT?.price).toBe(70000)
  })

  it('calls console.log with "Gelen Fiyat:" for every message', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      renderHook(() => useLivePrices(['LSKUSDT']))

      await act(async () => {
        MockWebSocket.openAll()
      })

      act(() => {
        MockWebSocket.emit(undefined, { s: 'LSKUSDT', c: '1.0095' })
      })

      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith('Gelen Fiyat:', 'LSKUSDT', '1.0095')
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps prices for other symbols when adding a new symbol', async () => {
    const { unmount } = renderHook(() => useLivePrices(['BTCUSDT', 'LSKUSDT']))

    await act(async () => {
      MockWebSocket.openAll()
    })

    act(() => {
      MockWebSocket.emit(MockWebSocket.instances[0], {
        s: 'BTCUSDT',
        c: '70000',
      })
      MockWebSocket.emit(MockWebSocket.instances[1], {
        s: 'LSKUSDT',
        c: '1.0095',
      })
    })

    await vi.waitFor(() => {
      expect(useMarketStore.getState().livePrices.BTCUSDT).toBe(70000)
    })
    expect(useMarketStore.getState().livePrices.LSKUSDT).toBe(1.0095)

    unmount()

    expect(useMarketStore.getState().livePrices.BTCUSDT).toBe(70000)
    expect(useMarketStore.getState().livePrices.LSKUSDT).toBe(1.0095)
  })

  it('closes sockets when the hook unmounts', async () => {
    const { unmount } = renderHook(() => useLivePrices(['BTCUSDT']))

    await act(async () => {
      MockWebSocket.openAll()
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    unmount()

    // after close, emitting on the same socket should not change the store
    useMarketStore.setState({ livePrices: {} })
    act(() => {
      MockWebSocket.emit(MockWebSocket.instances[0], {
        s: 'BTCUSDT',
        c: '999',
      })
    })
    expect(useMarketStore.getState().livePrices.BTCUSDT).toBeUndefined()
  })
})
