import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from '@testing-library/react'
import {
  FALLBACK_PAIR_SYMBOLS,
  resetMarketStream,
  useAllTickers,
} from '@/hooks/useAllTickers'
import { MockWebSocket } from '@/test/setup'

interface FetchResolved {
  ok: boolean
  json: () => Promise<unknown[]>
}

function stubFetch(data: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (): Promise<FetchResolved> => ({ ok: true, json: async () => data }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  MockWebSocket.reset()
  resetMarketStream()
  stubFetch([])
})

describe('useAllTickers', () => {
  it('seeds tickers from the REST snapshot and filters non-USDT pairs', async () => {
    stubFetch([
      { s: 'BTCUSDT', c: '65000', p: '1000', P: '1.5', v: '5000' },
      { s: 'ETHBTC', c: '0.05', p: '0', P: '0', v: '0' },
      { s: 'SOLUSDT', c: '150', p: '-3', P: '-2', v: '8000' },
    ])

    const { result } = renderHook(() => useAllTickers())

    await vi.waitFor(() => {
      expect(result.current.tickers.BTCUSDT?.price).toBe(65000)
    })
    expect(result.current.tickers.SOLUSDT?.changePercent24h).toBe(-2)
    expect(result.current.tickers.ETHBTC).toBeUndefined()
  })

  it('falls back to the futures endpoint when the spot endpoint fails', async () => {
    const fetchMock = vi.fn(async (url: string): Promise<FetchResolved> => {
      if (String(url).includes('/api/v3/ticker/24hr')) {
        throw new Error('spot blocked')
      }
      return {
        ok: true,
        json: async () => [
          { s: 'BTCUSDT', c: '62000', p: '0', P: '0', v: '0' },
          { s: 'ETHUSDT', c: '3100', p: '0', P: '0', v: '0' },
        ],
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAllTickers())

    await vi.waitFor(() => {
      expect(result.current.tickers.BTCUSDT?.price).toBe(62000)
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('fapi.binance.com'))
  })

  it('applies live price updates from the combined ticker stream', async () => {
    const { result } = renderHook(() => useAllTickers())

    act(() => {
      MockWebSocket.openAll()
    })

    act(() => {
      MockWebSocket.emit(undefined, {
        stream: '!ticker@arr',
        data: [{ s: 'PEPEUSDT', c: '0.00001', p: '0.000001', P: '0.7', v: '9999' }],
      })
    })

    await vi.waitFor(() => {
      expect(result.current.tickers.PEPEUSDT?.price).toBe(0.00001)
    })
  })

  it('keeps a built-in fallback list when every source is unavailable', async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAllTickers())

    expect(result.current.tickers.BTCUSDT?.price).toBeGreaterThan(0)
    expect(result.current.tickers.PEPEUSDT).toBeDefined()
    expect(Object.keys(result.current.tickers).length).toBe(FALLBACK_PAIR_SYMBOLS.length)
  })

  it('ignores malformed socket frames', async () => {
    const { result } = renderHook(() => useAllTickers())

    act(() => {
      MockWebSocket.openAll()
      MockWebSocket.emit(undefined, '{not valid json')
      MockWebSocket.emit(undefined, { data: 'nope' })
    })

    await vi.waitFor(() => {
      expect(result.current.tickers.BTCUSDT?.price).toBeGreaterThan(0)
    })
    const fallbackBtcPrice = result.current.tickers.BTCUSDT?.price
    act(() => {
      MockWebSocket.emit(undefined, { data: 'still bad' })
    })
    expect(result.current.tickers.BTCUSDT?.price).toBe(fallbackBtcPrice)
  })

  it('automatically reconnects 2 seconds after the socket drops', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useAllTickers())

      act(() => {
        MockWebSocket.openAll()
      })
      expect(MockWebSocket.instances).toHaveLength(1)

      act(() => {
        MockWebSocket.instances[0]?.onclose?.()
      })
      expect(result.current.status).toBe('offline')

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      expect(MockWebSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})