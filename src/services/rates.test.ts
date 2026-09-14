import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchUsdTryRate } from '@/services/rates'

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body }
}

function errorResponse() {
  return { ok: false, json: async () => ({}) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchUsdTryRate', () => {
  it('returns the live USDTTRY price from Binance', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ symbol: 'USDTTRY', price: '34.56' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUsdTryRate()).resolves.toBe(34.56)

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/v3/ticker/price')
    expect(url).toContain('symbol=USDTTRY')
  })

  it('tries the Binance mirror host when the primary is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(jsonResponse({ symbol: 'USDTTRY', price: '' }))
      .mockReturnValueOnce(jsonResponse({ symbol: 'USDTTRY', price: '35.12' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUsdTryRate()).resolves.toBe(35.12)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the ECB-backed Frankfurter API when Binance fails', async () => {
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(errorResponse())
      .mockReturnValueOnce(errorResponse())
      .mockReturnValueOnce(jsonResponse({ rates: { TRY: 38.9 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUsdTryRate()).resolves.toBe(38.9)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects when every data source is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse()))

    await expect(fetchUsdTryRate()).rejects.toThrow('USDT/TRY kuru alınamadı')
  })
})