import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VirtualTradePanel } from '@/components/markets/VirtualTradePanel'
import { useTradeStore } from '@/store/tradeStore'
import { useSettingsStore } from '@/store/settingsStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useSettingsStore.getState().setConfirmOrders(false)
  useTradeStore.setState({ balance: 1000 })
})

describe('VirtualTradePanel (reel panel standardı)', () => {
  it('gelişmiş arayüz öğelerini eksiksiz gösterir', async () => {
    render(<VirtualTradePanel symbol="ENTES" marketPrice={10} />)
    // Havuz fiyatı yüklenince başlık satırı gelir.
    await waitFor(() => {
      expect(screen.getByText('Elindeki ENTES')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Order type')).toBeInTheDocument()
    expect(screen.getByLabelText('Order amount')).toBeInTheDocument()
    // Yüzde butonları + Max.
    for (const label of ['25%', '50%', '75%', '100%']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Max' })).toBeInTheDocument()
    // TP/SL akordeonu + gelişmiş seçenekler.
    expect(screen.getByRole('button', { name: /TP\/SL/ })).toBeInTheDocument()
    expect(screen.getByLabelText(/Sadece Azalt/)).toBeInTheDocument()
    expect(screen.getByLabelText('Post-Only')).toBeInTheDocument()
    expect(screen.getByLabelText('Time in force')).toBeInTheDocument()
    // AMM alt bilgisi.
    expect(screen.getByText('Havuz ücreti')).toBeInTheDocument()
    expect(screen.getByText('Fiyat etkisi')).toBeInTheDocument()
  })

  it('limit seçilince fiyat kutusu açılır ve piyasa fiyatını izler', async () => {
    const user = userEvent.setup()
    render(<VirtualTradePanel symbol="ENTES" marketPrice={10} />)
    await waitFor(() => {
      expect(screen.getByText('Elindeki ENTES')).toBeInTheDocument()
    })
    await user.click(screen.getByLabelText('Order type'))
    await user.click(screen.getByRole('option', { name: 'Limit' }))
    const price = screen.getByLabelText('Order price') as HTMLInputElement
    expect(price.value).toBe('10')
  })

  it('lockedSide sekmeleri gizler, tek yöne kilitler', async () => {
    render(<VirtualTradePanel symbol="ENTES" marketPrice={10} initialSide="sell" lockedSide />)
    await waitFor(() => {
      expect(screen.getByText('Elindeki ENTES')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Al (Buy)' })).toBeNull()
    expect(screen.getByText('Satış Emri')).toBeInTheDocument()
    // Tek submit: satış.
    expect(screen.getByRole('button', { name: 'ENTES Sat' })).toBeInTheDocument()
  })

  it('kesen limit anında gerçekleşir, kesmeyen askıya park eder', async () => {
    const user = userEvent.setup()
    render(<VirtualTradePanel symbol="ENTES" marketPrice={10} />)
    await waitFor(() => {
      expect(screen.getByText('Elindeki ENTES')).toBeInTheDocument()
    })
    await user.click(screen.getByLabelText('Order type'))
    await user.click(screen.getByRole('option', { name: 'Limit' }))
    // Piyasanın ALTINDA alış limiti → kesmez → askıya alınır.
    await user.clear(screen.getByLabelText('Order price'))
    await user.type(screen.getByLabelText('Order price'), '9')
    await user.type(screen.getByLabelText('Order amount'), '100')
    const buttons = screen.getAllByRole('button', { name: 'ENTES Al' })
    await user.click(buttons[buttons.length - 1])
    await waitFor(() => {
      expect(useTradeStore.getState().virtualPending).toHaveLength(1)
    })
    expect(useTradeStore.getState().virtualPending[0]).toMatchObject({
      symbol: 'ENTES',
      side: 'buy',
      amount: 100,
      limitPrice: 9,
    })
    expect(screen.getByText('Askıdaki Emirler')).toBeInTheDocument()
  })

  it('piyasa alışı havuzda gerçekleşip ortalamayı işler', async () => {
    localStorage.setItem(
      'deniztradx_session',
      JSON.stringify({ id: 'u_test', username: 'tester', email: 't@x.com', createdAt: 1 }),
    )
    const user = userEvent.setup()
    render(<VirtualTradePanel symbol="ENTES" marketPrice={10} />)
    await waitFor(() => {
      expect(screen.getByText('Elindeki ENTES')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('Order amount'), '100')
    const buttons = screen.getAllByRole('button', { name: 'ENTES Al' })
    await user.click(buttons[buttons.length - 1])
    await waitFor(() => {
      expect(useTradeStore.getState().virtualAvgCosts.ENTES).toBeGreaterThan(0)
    })
  })

  it('DNZ satışta varsayılan birim USDT olur, dolar girilir', async () => {
    localStorage.setItem(
      'deniztradx_session',
      JSON.stringify({ id: 'u_test', username: 'tester', email: 't@x.com', createdAt: 1 }),
    )
    const user = userEvent.setup()
    render(<VirtualTradePanel symbol="DNZ" marketPrice={0.5} initialSide="sell" />)
    await waitFor(() => {
      expect(screen.getByText('Elindeki DNZ')).toBeInTheDocument()
    })
    // USDT birimi seçili gelir.
    expect(screen.getByRole('button', { name: 'USDT' })).toHaveAttribute('aria-pressed', 'true')
    // 100 USDT'lik satış → ~200 DNZ karşılığı kotasyon + fiyat etkisi görünür.
    await user.type(screen.getByLabelText('Order amount'), '100')
    await waitFor(() => {
      expect(screen.getByText('Satılacak (tahmini)')).toBeInTheDocument()
    })
    expect(screen.getByText('Fiyat etkisi')).toBeInTheDocument()
  })
})

