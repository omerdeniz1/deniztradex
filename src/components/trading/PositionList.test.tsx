import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PositionList } from '@/components/trading/PositionList'
import { useTradeStore } from '@/store/tradeStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
})

function renderList() {
  return render(<PositionList livePrices={{ BTCUSDT: 120 }} />)
}

function openFuturesLong() {
  useTradeStore.setState({ balance: 1000 })
  useTradeStore.getState().openPosition({
    symbol: 'BTCUSDT',
    side: 'long',
    mode: 'futures',
    quantity: 1,
    entryPrice: 100,
    leverage: 10,
  })
}

describe('PositionList', () => {
  it('shows a friendly empty state', () => {
    renderList()
    expect(screen.getByText(/No open positions/)).toBeInTheDocument()
  })

  it('renders live PnL and ROE based on the ticker price', () => {
    openFuturesLong()
    renderList()

    // margin 10 at entry 100 -> price 120 -> pnl 20 -> roe 200%
    expect(screen.getByText('20,00 (200,00%)')).toBeInTheDocument()
    expect(screen.getByText('long')).toBeInTheDocument()
  })

  it('recomputes PnL and ROE when the live ticker price changes', () => {
    openFuturesLong()
    const { rerender } = renderList()

    expect(screen.getByText('20,00 (200,00%)')).toBeInTheDocument()

    rerender(<PositionList livePrices={{ BTCUSDT: 90 }} />)

    // price 90 -> pnl -10 -> roe -100%
    expect(screen.getByText('-10,00 (-100,00%)')).toBeInTheDocument()
  })

  it('closes a position when the Close button is clicked', async () => {
    const user = userEvent.setup()
    openFuturesLong()
    renderList()

    await user.click(screen.getByRole('button', { name: 'Close' }))

    const state = useTradeStore.getState()
    expect(state.positions).toHaveLength(0)
    expect(state.balance).toBeCloseTo(1020) // 990 after margin + margin 10 + pnl 20
  })

  it('shows entry price and zero PnL when no live price is available for the symbol', () => {
    openFuturesLong()
    render(<PositionList livePrices={{}} />)

    // Mark falls back to entry (100); PnL / ROE start at 0 because live == entry
    expect(screen.getAllByText('100')).toHaveLength(2)
    expect(screen.getByText('0,00 (0,00%)')).toBeInTheDocument()
  })
})