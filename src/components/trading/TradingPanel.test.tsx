import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TradingPanel } from '@/components/trading/TradingPanel'
import { useTradeStore } from '@/store/tradeStore'
import { useSettingsStore } from '@/store/settingsStore'
import type { Ticker, TradingMode } from '@/types'

const btcTicker: Ticker = {
  symbol: 'BTCUSDT',
  price: 100,
  change24h: 2,
  changePercent24h: 2,
  volume24h: 5000,
}

const lskTicker: Ticker = {
  symbol: 'LSKUSDT',
  price: 5,
  change24h: 0.1,
  changePercent24h: 2,
  volume24h: 200,
}

interface PanelOptions {
  mode?: TradingMode
  ticker?: Ticker | null
  balance?: number
  marketPrice?: number
}

function renderPanel({ mode = 'spot', ticker = btcTicker, balance = 0, marketPrice }: PanelOptions = {}) {
  return render(
    <TradingPanel ticker={ticker} mode={mode} balance={balance} marketPrice={marketPrice} />,
  )
}

/** The big submit button and the active tab share a label, so pick the last one (submit is last in DOM). */
function clickSubmit(name: string) {
  const buttons = screen.getAllByRole('button', { name })
  return buttons[buttons.length - 1]
}

function switchToSell() {
  // while side is 'buy', only the tab carries the 'Sat (Sell)' label
  return screen.getByRole('button', { name: 'Sat (Sell)' })
}

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useSettingsStore.getState().setConfirmOrders(false)
})

describe('TradingPanel sheet options', () => {
  it('hides the trigger-type row when showTriggerType is false', () => {
    render(
      <TradingPanel ticker={btcTicker} mode="spot" balance={1000} marketPrice={100} showTriggerType={false} />,
    )
    expect(screen.queryByLabelText('Trigger type')).toBeNull()
    // TP/SL akordeonu varsayılan kapalıdır — buton durur, kutular gizlidir
    expect(screen.getByRole('button', { name: /TP\/SL/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('Take profit price')).toBeNull()
    expect(screen.queryByLabelText('Stop loss price')).toBeNull()
  })

  it('expands TP/SL inputs when the accordion is opened', async () => {
    const user = userEvent.setup()
    render(
      <TradingPanel ticker={btcTicker} mode="spot" balance={1000} marketPrice={100} showTriggerType={false} />,
    )
    await user.click(screen.getByRole('button', { name: /TP\/SL/ }))
    expect(screen.getByLabelText('Take profit price')).toBeInTheDocument()
    expect(screen.getByLabelText('Stop loss price')).toBeInTheDocument()
  })

  it('shows the trigger-type row by default and preselects the side', () => {
    render(
      <TradingPanel ticker={btcTicker} mode="spot" balance={1000} marketPrice={100} initialSide="sell" />,
    )
    expect(screen.getByLabelText('Trigger type')).toBeInTheDocument()
    // Sekme + submit butonu aynı etiketi taşır — ikisinin de Sat olması yönün seçildiğini kanıtlar.
    expect(screen.getAllByRole('button', { name: 'Sat (Sell)' })).toHaveLength(2)
  })
})

describe('TradingPanel price sync', () => {
  it('auto-fills the price from the live ticker', () => {
    renderPanel({ balance: 1000 })
    expect((screen.getByLabelText('Order price') as HTMLInputElement).value).toBe('100')
  })

  it('falls back to the market price while the ticker stream is still loading', () => {
    renderPanel({ ticker: null, marketPrice: 5.25 })
    expect((screen.getByLabelText('Order price') as HTMLInputElement).value).toBe('5.25')
  })

  it('adopts the new coin market price when the selected coin changes', async () => {
    const user = userEvent.setup()
    const { rerender } = renderPanel({ balance: 1000 })

    await user.clear(screen.getByLabelText('Order price'))
    await user.type(screen.getByLabelText('Order price'), '123')

    rerender(
      <TradingPanel ticker={lskTicker} mode="spot" balance={1000} marketPrice={5} />,
    )

    await waitFor(() => {
      expect((screen.getByLabelText('Order price') as HTMLInputElement).value).toBe('5')
    })
  })

  it('keeps a manual price edit while the same coin ticks', async () => {
    const user = userEvent.setup()
    const { rerender } = renderPanel({ balance: 1000 })

    await user.clear(screen.getByLabelText('Order price'))
    await user.type(screen.getByLabelText('Order price'), '123')
    expect((screen.getByLabelText('Order price') as HTMLInputElement).value).toBe('123')

    rerender(
      <TradingPanel ticker={{ ...btcTicker, price: 101 }} mode="spot" balance={1000} />,
    )

    expect((screen.getByLabelText('Order price') as HTMLInputElement).value).toBe('123')
  })
})

describe('TradingPanel spot mode', () => {
  it('shows Al/Sat buttons and hides futures-only controls', () => {
    renderPanel({ balance: 1000 })
    expect(screen.getAllByRole('button', { name: 'Al (Buy)' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Sat (Sell)' }).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Leverage slider')).not.toBeInTheDocument()
    expect(screen.queryByText('Margin / Lev')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Buy / Long' })).not.toBeInTheDocument()
  })

  it('buys coins: USDT balance down, coin balance up, no futures position', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 1000 })
    renderPanel({ balance: 1000 })

    await user.type(screen.getByLabelText('Order amount'), '500')
    await user.click(clickSubmit('Al (Buy)'))

    const state = useTradeStore.getState()
    expect(state.spotBalances.BTC).toBeCloseTo(5)
    expect(state.balance).toBeCloseTo(500)
    expect(state.positions).toHaveLength(0)
    expect(state.spotTrades).toHaveLength(1)
    expect(state.spotTrades[0].side).toBe('buy')
  })

  it('clears the amount after a successful buy', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 1000 })
    renderPanel({ balance: 1000 })

    await user.type(screen.getByLabelText('Order amount'), '100')
    await user.click(clickSubmit('Al (Buy)'))

    expect((screen.getByLabelText('Order amount') as HTMLInputElement).value).toBe('')
  })

  it('rejects a buy beyond the USDT balance', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 50 })
    renderPanel({ balance: 50 })

    await user.type(screen.getByLabelText('Order amount'), '500')
    await user.click(clickSubmit('Al (Buy)'))

    expect(await screen.findByText(/Insufficient USDT balance/)).toBeInTheDocument()
    expect(useTradeStore.getState().spotBalances.BTC ?? 0).toBe(0)
  })

  it('sells coins: coin balance down, USDT up', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100, spotBalances: { BTC: 10 } })
    renderPanel({ balance: 100 })

    await user.click(switchToSell())
    expect(screen.getByText('Available (BTC)')).toBeInTheDocument()
    expect(screen.getAllByText(/10 BTC/).length).toBeGreaterThan(0)

    await user.type(screen.getByLabelText('Order amount'), '500')
    await user.click(clickSubmit('Sat (Sell)'))

    const state = useTradeStore.getState()
    expect(state.spotBalances.BTC).toBeCloseTo(5)
    expect(state.balance).toBeCloseTo(600)
    expect(state.spotTrades[0].side).toBe('sell')
  })

  it('rejects a sell beyond the held coin amount', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ spotBalances: { BTC: 2 } })
    renderPanel()

    await user.click(switchToSell())
    await user.type(screen.getByLabelText('Order amount'), '500') // 5 BTC needed

    await user.click(clickSubmit('Sat (Sell)'))

    expect(await screen.findByText(/Insufficient BTC balance/)).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('waits for confirmation when confirmations are enabled', async () => {
    const user = userEvent.setup()
    useSettingsStore.getState().setConfirmOrders(true)
    useTradeStore.setState({ balance: 1000 })
    renderPanel({ balance: 1000 })

    await user.type(screen.getByLabelText('Order amount'), '500')
    await user.click(clickSubmit('Al (Buy)'))

    expect(screen.getByText('Emri Onayla')).toBeInTheDocument()
    expect(useTradeStore.getState().spotBalances.BTC ?? 0).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Onayla ve Gönder' }))

    expect(useTradeStore.getState().spotBalances.BTC).toBeCloseTo(5)
    expect(useTradeStore.getState().balance).toBeCloseTo(500)
    await waitFor(() => {
      expect(screen.queryByText('Emri Onayla')).not.toBeInTheDocument()
    })
  })

  it('cancels without trading when confirmation is dismissed', async () => {
    const user = userEvent.setup()
    useSettingsStore.getState().setConfirmOrders(true)
    useTradeStore.setState({ balance: 1000 })
    renderPanel({ balance: 1000 })

    await user.type(screen.getByLabelText('Order amount'), '300')
    await user.click(clickSubmit('Al (Buy)'))
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }))

    expect(useTradeStore.getState().spotBalances.BTC ?? 0).toBe(0)
    expect(useTradeStore.getState().balance).toBe(1000)
    await waitFor(() => {
      expect(screen.queryByText('Emri Onayla')).not.toBeInTheDocument()
    })
  })
})

describe('TradingPanel futures mode', () => {
  it('keeps the leverage slider and Buy / Long positions flow', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 1000 })
    renderPanel({ mode: 'futures', balance: 1000 })

    expect(screen.getByLabelText('Leverage slider')).toBeInTheDocument()
    expect(screen.getByText('Margin / Lev')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Order amount'), '500')
    await user.click(screen.getByRole('button', { name: 'Buy / Long' }))

    const state = useTradeStore.getState()
    expect(state.positions).toHaveLength(1)
    expect(state.positions[0].side).toBe('long')
    expect(state.positions[0].quantity).toBeCloseTo(5)
    expect(state.balance).toBeCloseTo(950) // margin = 500/10
  })

  it('defaults to Isolated margin and switches to Cross on one tap', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 1000 })
    renderPanel({ mode: 'futures', balance: 1000 })

    const isolated = screen.getByRole('button', { name: 'İzole' })
    const cross = screen.getByRole('button', { name: 'Çapraz' })
    expect(isolated).toHaveAttribute('aria-pressed', 'true')
    expect(cross).toHaveAttribute('aria-pressed', 'false')

    await user.click(cross)
    expect(isolated).toHaveAttribute('aria-pressed', 'false')
    expect(cross).toHaveAttribute('aria-pressed', 'true')

    await user.type(screen.getByLabelText('Order amount'), '500')
    await user.click(screen.getByRole('button', { name: 'Buy / Long' }))

    expect(useTradeStore.getState().positions[0].marginMode).toBe('cross')
  })
})

describe('TradingPanel Max button', () => {
  it('writes the full available balance rounded to 2 decimals in spot buy mode', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 101.35 })
    renderPanel({ balance: 101.35 })

    await user.click(screen.getByRole('button', { name: 'Max' }))

    expect((screen.getByLabelText('Order amount') as HTMLInputElement).value).toBe('101.35')
  })

  it('writes the leverage-scaled volume rounded to 2 decimals in futures mode', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 101.35 })
    renderPanel({ mode: 'futures', balance: 101.35 })

    await user.click(screen.getByRole('button', { name: 'Max' }))

    // default leverage is 10 → 101.35 * 10 = 1013.50, never a long float tail
    expect((screen.getByLabelText('Order amount') as HTMLInputElement).value).toBe('1013.50')
  })

  it('writes the held coin notional rounded to 2 decimals in spot sell mode', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 1000, spotBalances: { BTC: 10 } })
    renderPanel({ balance: 1000 })

    await user.click(switchToSell())
    await user.click(screen.getByRole('button', { name: 'Max' }))

    // 10 BTC * 100 USDT = 1000.00 — no long float tail
    expect((screen.getByLabelText('Order amount') as HTMLInputElement).value).toBe('1000.00')
  })
})