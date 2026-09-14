import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthScreen } from '@/components/auth/AuthScreen'
import { useAuthStore } from '@/store/authStore'

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().logout()
})

async function fillRegisterForm(user: ReturnType<typeof userEvent.setup>, referral?: string) {
  await user.click(screen.getByRole('button', { name: 'Kayıt Ol' }))

  const nameInput = await screen.findByPlaceholderText('örn. deniz_trader')
  await user.type(nameInput, 'deniz_ui')
  await user.type(screen.getByPlaceholderText('ornek@eposta.com'), 'deniz@ui.com')

  const passwordInputs = screen.getAllByPlaceholderText('••••••••')
  await user.type(passwordInputs[0], '123456')
  await user.type(passwordInputs[1], '123456')

  if (referral !== undefined) {
    await user.type(screen.getByPlaceholderText('örn. testref2026'), referral)
  }
  await user.click(screen.getByRole('button', { name: 'Kayıt Ol ve Başla' }))
}

describe('AuthScreen — referral code validation', () => {
  it('shows a red "Geçersiz referans kodu" error for an unknown code', async () => {
    const user = userEvent.setup()
    render(<AuthScreen />)

    await fillRegisterForm(user, 'rastgele-yazi')

    const error = await screen.findByText('Geçersiz referans kodu.')
    expect(error.className).toContain('text-exchange-sell')
    expect(localStorage.getItem('deniztradx_session')).toBeNull()
  })

  it('registers normally when the referral field is left empty', async () => {
    const user = userEvent.setup()
    render(<AuthScreen />)

    await fillRegisterForm(user)

    await waitFor(() => {
      expect(localStorage.getItem('deniztradx_session')).toContain('deniz_ui')
    })
    expect(screen.queryByText('Geçersiz referans kodu.')).not.toBeInTheDocument()
  })

  it('registers with the valid testref2026 referral code', async () => {
    const user = userEvent.setup()
    render(<AuthScreen />)

    await fillRegisterForm(user, 'testref2026')

    await waitFor(() => {
      expect(localStorage.getItem('deniztradx_session')).toContain('deniz_ui')
    })
    expect(screen.queryByText('Geçersiz referans kodu.')).not.toBeInTheDocument()
  })
})