import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  TRANSFER_WAIT_MS,
  transferWait,
  WithdrawModal,
} from '@/components/wallet/WithdrawModal'
import { withdrawMethodsStorageKeyFor } from '@/services/withdrawMethods'
import { useTradeStore } from '@/store/tradeStore'

type User = ReturnType<typeof userEvent.setup>

const SESSION_USER = {
  id: 'usr_test_1',
  username: 'deniz',
  email: 'deniz@x.com',
  createdAt: 1,
}

function sessionMethodsKey(): string {
  return withdrawMethodsStorageKeyFor(SESSION_USER.id)
}

async function fillCard(user: User, amount: string) {
  await user.type(screen.getByPlaceholderText('XXXX XXXX XXXX XXXX'), '4242424242424242')
  await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
  await user.type(screen.getByPlaceholderText('örn. 250'), amount)
}

async function awaitSuccess() {
  expect(
    await screen.findByText(/bakiyenizden çekildi/, {}, { timeout: 2000 }),
  ).toBeInTheDocument()
}

function savedMethods(): Array<Record<string, unknown>> {
  const raw = localStorage.getItem(sessionMethodsKey())
  return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : []
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('deniztradx_session', JSON.stringify(SESSION_USER))
  transferWait.ms = 100
  useTradeStore.getState().resetWallet()
  vi.clearAllMocks()
})

afterEach(() => {
  transferWait.ms = TRANSFER_WAIT_MS
})

describe('WithdrawModal', () => {
  it('submits the withdrawal request and deducts USDT from the balance', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await fillCard(user, '30')
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))

    expect(screen.getByText('Hesabınıza transfer ediliyor…')).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(100)

    await awaitSuccess()
    expect(useTradeStore.getState().balance).toBeCloseTo(70)
    expect(useTradeStore.getState().withdrawals).toHaveLength(1)
    expect(useTradeStore.getState().withdrawals[0].amount).toBeCloseTo(30)
  })

  it('uses exactly 4 seconds (4000 ms) as the transfer window', () => {
    expect(TRANSFER_WAIT_MS).toBe(4000)
  })

  it('shows Yetersiz Bakiye and blocks a request above the balance', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await fillCard(user, '150')
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))

    expect(screen.getByText('Yetersiz Bakiye')).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(100)
    expect(useTradeStore.getState().withdrawals).toHaveLength(0)
  })

  it('requires a valid card number before submitting', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
    await user.type(screen.getByPlaceholderText('örn. 250'), '30')
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))

    expect(screen.getByText('Lütfen geçerli bir kart numarası girin.')).toBeInTheDocument()
    expect(useTradeStore.getState().balance).toBe(100)
  })

  it('accepts an IBAN method withdrawal', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 200 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'IBAN' }))
    await user.type(
      screen.getByPlaceholderText('TR00 0000 0000 0000 0000 0000'),
      'TR330006100519786457841326',
    )
    await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
    await user.type(screen.getByPlaceholderText('örn. 250'), '50')
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))

    await awaitSuccess()
    expect(useTradeStore.getState().balance).toBeCloseTo(150)
  })

  it('does not allow closing while the transfer is running', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={onClose} />)

    await fillCard(user, '20')
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))
    await user.click(screen.getByRole('button', { name: 'Kapat' }))

    expect(onClose).not.toHaveBeenCalled()

    await awaitSuccess()
  })

  it('saves the card as a withdraw method when “Bu kartı kaydet” is checked', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await fillCard(user, '30')
    await user.click(screen.getByRole('checkbox', { name: 'Bu kartı kaydet' }))
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))
    await awaitSuccess()

    const methods = savedMethods()
    expect(methods).toHaveLength(1)
    expect(methods[0]).toMatchObject({
      method: 'card',
      accountNumber: '4242424242424242',
      holderName: 'DENIZ DEMO',
    })
  })

  it('saves an IBAN when the IBAN method is used and the checkbox is checked', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 200 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'IBAN' }))
    await user.type(
      screen.getByPlaceholderText('TR00 0000 0000 0000 0000 0000'),
      'TR330006100519786457841326',
    )
    await user.type(screen.getByPlaceholderText('AD SOYAD'), 'DENIZ DEMO')
    await user.type(screen.getByPlaceholderText('örn. 250'), '50')
    await user.click(screen.getByRole('checkbox', { name: 'Bu IBAN’ı kaydet' }))
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))
    await awaitSuccess()

    const methods = savedMethods()
    expect(methods).toHaveLength(1)
    expect(methods[0]).toMatchObject({
      method: 'iban',
      accountNumber: 'TR330006100519786457841326',
      holderName: 'DENIZ DEMO',
    })
  })

  it('does not save the method when the checkbox is left unchecked', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await fillCard(user, '30')
    await user.click(screen.getByRole('button', { name: 'Çekim Talebi Gönder' }))
    await awaitSuccess()

    expect(savedMethods()).toHaveLength(0)
  })

  it('autofills the form from a saved card with a single click', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    localStorage.setItem(
      sessionMethodsKey(),
      JSON.stringify([
        {
          id: 'm1',
          method: 'card',
          accountNumber: '4242424242424242',
          holderName: 'DENIZ DEMO',
          savedAt: 1,
        },
      ]),
    )
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Kayıtlı Yöntemlerim/ }))
    await user.click(screen.getByRole('button', { name: /DENIZ DEMO/ }))

    expect(screen.getByPlaceholderText('XXXX XXXX XXXX XXXX')).toHaveValue(
      '4242 4242 4242 4242',
    )
    expect(screen.getByPlaceholderText('AD SOYAD')).toHaveValue('DENIZ DEMO')
  })

  it('autofills an IBAN method and switches the method selector', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    localStorage.setItem(
      sessionMethodsKey(),
      JSON.stringify([
        {
          id: 'i1',
          method: 'iban',
          accountNumber: 'TR330006100519786457841326',
          holderName: 'DENIZ DEMO',
          savedAt: 1,
        },
      ]),
    )
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Kayıtlı Yöntemlerim/ }))
    await user.click(screen.getByRole('button', { name: /DENIZ DEMO/ }))

    expect(screen.getByPlaceholderText('TR00 0000 0000 0000 0000 0000')).toHaveValue(
      'TR33 0006 1005 1978 6457 8413 26',
    )
    expect(screen.getByPlaceholderText('AD SOYAD')).toHaveValue('DENIZ DEMO')
  })

  it('deletes a saved withdraw method', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    localStorage.setItem(
      sessionMethodsKey(),
      JSON.stringify([
        {
          id: 'm1',
          method: 'card',
          accountNumber: '4242424242424242',
          holderName: 'DENIZ DEMO',
          savedAt: 1,
        },
      ]),
    )
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Kayıtlı Yöntemlerim/ }))
    await user.click(screen.getByRole('button', { name: /kayıtlı yöntemini sil/ }))

    expect(savedMethods()).toHaveLength(0)
  })

  it('fills the full available balance via “Tümünü Çek”', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 250 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Tümünü Çek' }))

    expect(screen.getByPlaceholderText('örn. 250')).toHaveValue('250.00')
  })

  it('blocks digits and special characters in the account holder name', async () => {
    const user = userEvent.setup()
    useTradeStore.setState({ balance: 100 })
    render(<WithdrawModal open onClose={vi.fn()} />)

    const nameInput = screen.getByPlaceholderText('AD SOYAD')
    await user.type(nameInput, 'DEN1Z123@!#$&')
    expect(nameInput).toHaveValue('DENZ')

    await user.type(nameInput, ' DEMO')
    expect(nameInput).toHaveValue('DENZ DEMO')
  })
})