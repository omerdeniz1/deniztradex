import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WalletPage } from '@/pages/WalletPage'
import { useTradeStore } from '@/store/tradeStore'

const confettiMock = vi.hoisted(() => vi.fn())
vi.mock('canvas-confetti', () => ({ default: confettiMock }))

beforeEach(() => {
  useTradeStore.getState().resetWallet()
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })))
})

describe('WalletPage promo codes', () => {
  it('credits the bonus for a valid unused code and fires confetti', async () => {
    const user = userEvent.setup()
    render(<WalletPage />)

    await user.type(screen.getByPlaceholderText('Örn. dnztrd100'), 'dnztrd100')
    await user.click(screen.getByRole('button', { name: 'Uygula' }))

    expect(await screen.findByText(/hesabınıza eklendi/)).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(100)
    expect(confettiMock).toHaveBeenCalled()
  })

  it('rejects a code that was already used and does not farm balance', async () => {
    useTradeStore.getState().redeemPromo('dnztrd100')
    const user = userEvent.setup()
    render(<WalletPage />)

    await user.type(screen.getByPlaceholderText('Örn. dnztrd100'), 'dnztrd100')
    await user.click(screen.getByRole('button', { name: 'Uygula' }))

    expect(await screen.findByText(/daha önce kullanıldı/)).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(100)
    expect(confettiMock).not.toHaveBeenCalled()
  })

  it('rejects unknown codes', async () => {
    const user = userEvent.setup()
    render(<WalletPage />)

    await user.type(screen.getByPlaceholderText('Örn. dnztrd100'), 'xyz')
    await user.click(screen.getByRole('button', { name: 'Uygula' }))

    expect(await screen.findByText(/Geçersiz promosyon kodu/)).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(0)
  })
})