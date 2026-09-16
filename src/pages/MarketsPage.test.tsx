import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import { MarketsPage } from '@/pages/MarketsPage'
import { MockWebSocket } from '@/test/setup'

function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => [
      { s: 'BTCUSDT', c: '65000', p: '1000', P: '1.5', v: '5000', q: '325000000' },
      { s: 'ETHBTC', c: '0.05', p: '0', P: '0', v: '0', q: '0' },
      { s: 'SOLUSDT', c: '150', p: '-3', P: '-2', v: '8000', q: '1200000' },
      { s: 'XRPUSDT', c: '0.55', p: '0.05', P: '1.2', v: '900000', q: '495000' },
    ],
  }))
  vi.stubGlobal('fetch', fetchMock)
}

function SpotStub() {
  const [params] = useSearchParams()
  return <div>spot-page:{params.get('symbol')}</div>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/markets" element={<MarketsPage />} />
        <Route path="/spot" element={<SpotStub />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  MockWebSocket.reset()
  stubFetch()
})

describe('MarketsPage', () => {
  it('lists every USDT pair from the ticker feed, excluding non-USDT', async () => {
    renderAt('/markets')

    await waitFor(() => {
      expect(screen.getByText('BTC')).toBeInTheDocument()
    })
    expect(screen.getByText('SOL')).toBeInTheDocument()
    expect(screen.getByText('XRP')).toBeInTheDocument()
    expect(screen.queryByText('ETHBTC')).not.toBeInTheDocument()
    expect(screen.getByText(/işlem çifti/)).toBeInTheDocument()
  })

  it('lists virtual coins in the same table with no special badge', async () => {
    renderAt('/markets')

    await screen.findByText('ENTES')
    // BTC satırıyla birebir aynı format: sembol + USDT etiketi.
    const row = screen.getByText('ENTES').closest('tr')!
    expect(row.textContent).toContain('USDT')
    // Rozet/ayrım yok: ne Sanal ibaresi ne ayrı sekme.
    expect(screen.queryByText(/Sanal/)).not.toBeInTheDocument()
    expect(screen.getByText('V-XAU')).toBeInTheDocument()
  })

  it('navigates a virtual coin to the trade screen with its own symbol', async () => {
    const user = userEvent.setup()
    // SpotStub /spot rotasında symbol parametresini gösterir.
    renderAt('/markets')
    await screen.findByText('ENTES')
    await user.click(screen.getByText('ENTES'))
    expect(await screen.findByText('spot-page:ENTES')).toBeInTheDocument()
  })

  it('filters coins with the search bar (aliases like solana work)', async () => {
    const user = userEvent.setup()
    renderAt('/markets')

    await screen.findByText('SOL')

    const search = screen.getByPlaceholderText(/Coin ara/)
    await user.type(search, 'solana')

    await waitFor(() => {
      expect(screen.getByText('SOL')).toBeInTheDocument()
      expect(screen.queryByText('BTC')).not.toBeInTheDocument()
      expect(screen.queryByText('XRP')).not.toBeInTheDocument()
    })
  })

  it('navigates to the trade screen for the clicked coin', async () => {
    const user = userEvent.setup()
    renderAt('/markets')

    await screen.findByText('SOL')
    await user.click(screen.getByText('SOL'))

    expect(await screen.findByText('spot-page:SOLUSDT')).toBeInTheDocument()
  })
})