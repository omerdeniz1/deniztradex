import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PairSelector } from '@/components/trading/PairSelector'
import { resetFuturesSymbolsCache } from '@/hooks/useFuturesSymbols'
import type { Ticker } from '@/types'

const tickers: Record<string, Ticker> = {
  BTCUSDT: { symbol: 'BTCUSDT', price: 64000, change24h: 100, changePercent24h: 1, volume24h: 1000 },
  ETHUSDT: { symbol: 'ETHUSDT', price: 3400, change24h: -10, changePercent24h: -0.5, volume24h: 500 },
  FAKEUSDT: { symbol: 'FAKEUSDT', price: 1, change24h: 0, changePercent24h: 0, volume24h: 10 },
}

function mockExchangeInfo(symbols: { symbol: string; status: string; contractType: string; quoteAsset: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ symbols }) }),
  )
}

function renderSelector(mode?: 'spot' | 'futures', virtualSymbols?: Set<string>) {
  return render(
    <PairSelector
      symbol="BTCUSDT"
      onSymbolChange={() => {}}
      tickers={tickers}
      live
      mode={mode}
      virtualSymbols={virtualSymbols}
    />,
  )
}

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /BTC\/USDT/ }))
}

beforeEach(() => {
  resetFuturesSymbolsCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PairSelector futures filtresi', () => {
  it('vadeli modda yalnızca kontratı olan coinleri listeler', async () => {
    mockExchangeInfo([
      { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    ])
    renderSelector('futures')
    await openMenu()

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /BTC/ })).toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: /ETH/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /FAKE/ })).not.toBeInTheDocument()
    expect(screen.getByText('2 vadeli kontrat')).toBeInTheDocument()
  })

  it('spot modda (veya modsuz) tüm coinleri listeler', async () => {
    mockExchangeInfo([
      { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    ])
    renderSelector('spot')
    await openMenu()

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /FAKE/ })).toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: /BTC/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /ETH/ })).toBeInTheDocument()
  })

  it('spot modda sanal sembolleri de listeler (USDT soneki aranmaz)', async () => {
    mockExchangeInfo([])
    render(
      <PairSelector
        symbol="BTCUSDT"
        onSymbolChange={() => {}}
        tickers={{
          ...tickers,
          ENTES: { symbol: 'ENTES', price: 10, change24h: 0, changePercent24h: 0, volume24h: 5 },
        }}
        live
        mode="spot"
        virtualSymbols={new Set(['ENTES'])}
      />,
    )
    await openMenu()

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /ENTES/ })).toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: /BTC/ })).toBeInTheDocument()
  })

  it('kontrat listesi alınamazsa filtre uygulamaz (fail-open)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ağ yok')),
    )
    renderSelector('futures')
    await openMenu()

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /FAKE/ })).toBeInTheDocument()
    })
  })
})
