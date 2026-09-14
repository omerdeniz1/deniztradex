import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BANK_WAIT_MS,
  bankWait,
  DepositModal,
} from '@/components/wallet/DepositModal'
import { CARDS_STORAGE_KEY } from '@/services/cards'
import { useTradeStore } from '@/store/tradeStore'

const confettiMock = vi.hoisted(() => vi.fn())
vi.mock('canvas-confetti', () => ({ default: confettiMock }))

const refreshMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useUsdTryRate', () => ({
  useUsdTryRate: () => ({ rate: 34, live: true, refresh: refreshMock }),
}))

const SESSION_USER = {
  id: 'usr_test_1',
  username: 'deniz',
  email: 'deniz@x.com',
  createdAt: 1,
}

type User = ReturnType<typeof userEvent.setup>

async function fillCard(user: User) {
  await user.type(screen.getByPlaceholderText('XXXX XXXX XXXX XXXX'), '4242424242424242')
  await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
  await user.type(screen.getByPlaceholderText('AA/YY'), '12/29')
  await user.type(screen.getByPlaceholderText('•••'), '123')
}

async function awaitSuccess() {
  expect(
    await screen.findByText(/bakiyenize eklendi/, {}, { timeout: 2000 }),
  ).toBeInTheDocument()
}

function savedCards(): Array<Record<string, unknown>> {
  const raw = localStorage.getItem(`${CARDS_STORAGE_KEY}_${SESSION_USER.id}`)
  return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : []
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('deniztradx_session', JSON.stringify(SESSION_USER))
  bankWait.ms = 100
  useTradeStore.getState().resetWallet()
  vi.clearAllMocks()
})

afterEach(() => {
  bankWait.ms = BANK_WAIT_MS
})

describe('DepositModal', () => {
  it('submits the bank payment after a 20s approval wait', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<DepositModal open onClose={onClose} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await fillCard(user)
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))

    expect(screen.getByText('Banka onayı bekleniyor…')).toBeInTheDocument()
    expect(screen.getByText('Lütfen sayfadan ayrılmayın.')).toBeInTheDocument()
    expect(screen.queryByText(/bakiyenize eklendi/)).not.toBeInTheDocument()

    await awaitSuccess()
    expect(useTradeStore.getState().balance).toBeCloseTo(28.97, 0)
    expect(confettiMock).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('uses exactly 5 seconds (5000 ms) as the bank approval window', () => {
    expect(BANK_WAIT_MS).toBe(5000)
  })

  it('honors preset TRY amounts', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '₺5.000' }))
    await fillCard(user)
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))
    await awaitSuccess()

    expect(useTradeStore.getState().balance).toBeCloseTo(144.85, 0)
  })

  it('blocks digits and special characters in the card holder name', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    const nameInput = screen.getByPlaceholderText('AD SOYAD')
    await user.type(nameInput, 'DEN1Z123@!#$&')
    expect(nameInput).toHaveValue('DENZ')

    await user.type(nameInput, ' DEMO')
    expect(nameInput).toHaveValue('DENZ DEMO')
  })

  it('requires card details before submitting', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))

    expect(screen.getByText('Lütfen kart bilgilerini eksiksiz girin.')).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('blocks an expired card date (11/01) with the expiry error', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await user.type(screen.getByPlaceholderText('XXXX XXXX XXXX XXXX'), '4242424242424242')
    await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
    await user.type(screen.getByPlaceholderText('AA/YY'), '11/01')
    await user.type(screen.getByPlaceholderText('•••'), '123')
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))

    expect(screen.getByText('Geçersiz veya süresi dolmuş kart')).toBeInTheDocument()
    expect(screen.queryByText(/bakiyenize eklendi/)).not.toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('blocks an out-of-range card month (13/29) with the expiry error', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await user.type(screen.getByPlaceholderText('XXXX XXXX XXXX XXXX'), '4242424242424242')
    await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
    await user.type(screen.getByPlaceholderText('AA/YY'), '13/29')
    await user.type(screen.getByPlaceholderText('•••'), '123')
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))

    expect(screen.getByText('Geçersiz veya süresi dolmuş kart')).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('does not allow closing while the bank approval is running', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<DepositModal open onClose={onClose} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await fillCard(user)
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))
    await user.click(screen.getByRole('button', { name: 'Kapat' }))

    expect(onClose).not.toHaveBeenCalled()

    await awaitSuccess()
  })

  it('closes when pressing Kapat after a successful deposit', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<DepositModal open onClose={onClose} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await fillCard(user)
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))
    await awaitSuccess()

    const closeButtons = screen.getAllByRole('button', { name: 'Kapat' })
    await user.click(closeButtons[closeButtons.length - 1])

    expect(onClose).toHaveBeenCalled()
  })

  it('saves the card (without CVC) when “Bu kartı kaydet” is checked', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await fillCard(user)
    await user.click(screen.getByRole('checkbox', { name: 'Bu kartı kaydet' }))
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))
    await awaitSuccess()

    const cards = savedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      holderName: 'DENIZ DEMO',
      number: '4242424242424242',
      expiry: '12/29',
      brand: 'VISA',
    })
    expect(cards[0].cvc).toBeUndefined()
  })

  it('autofills the form from a saved card with a single click', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await fillCard(user)
    await user.click(screen.getByRole('checkbox', { name: 'Bu kartı kaydet' }))
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))
    await awaitSuccess()

    const closeButtons = screen.getAllByRole('button', { name: 'Kapat' })
    await user.click(closeButtons[closeButtons.length - 1])

    await user.click(screen.getByRole('button', { name: /VISA.*4242/ }))

    expect(screen.getByPlaceholderText('XXXX XXXX XXXX XXXX')).toHaveValue(
      '4242 4242 4242 4242',
    )
    expect(screen.getByPlaceholderText('AD SOYAD')).toHaveValue('DENIZ DEMO')
    expect(screen.getByPlaceholderText('AA/YY')).toHaveValue('12/29')
    expect(screen.getByPlaceholderText('•••')).toHaveValue('')
  })

  it('does not save the card when the checkbox is left unchecked', async () => {
    const user = userEvent.setup()
    render(<DepositModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('örn. 34000'), '1000')
    await fillCard(user)
    await user.click(screen.getByRole('button', { name: /USDT Yatır/ }))
    await awaitSuccess()

    expect(savedCards()).toHaveLength(0)
  })
})