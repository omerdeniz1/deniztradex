import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/store/authStore'
import { useToastStore } from '@/store/toastStore'
import { useTradeStore } from '@/store/tradeStore'
import { VALID_REFERRAL_CODES } from '@/services/authService'
import { cardsStorageKeyFor, saveCard, getSavedCards } from '@/services/cards'

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().logout()
  useTradeStore.getState().resetWallet()
  useToastStore.setState({ toasts: [] })
})

describe('authStore', () => {
  it('registers a user and starts a session', async () => {
    await useAuthStore.getState().register({
      username: 'deniz',
      email: 'deniz@tradex.com',
      password: '123456',
    })

    const state = useAuthStore.getState()
    expect(state.user).not.toBeNull()
    expect(state.user!.username).toBe('deniz')
    expect(state.user!.email).toBe('deniz@tradex.com')
    expect(localStorage.getItem('deniztradx_session')).toContain('deniz')
  })

  it('rejects a duplicate username', async () => {
    const { register, logout } = useAuthStore.getState()
    await register({ username: 'deniz', email: 'a@a.com', password: '123456' })
    logout()

    await expect(
      register({ username: 'Deniz', email: 'b@b.com', password: '123456' }),
    ).rejects.toThrow('kullanılıyor')
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('rejects a duplicate email', async () => {
    const { register, logout } = useAuthStore.getState()
    await register({ username: 'deniz', email: 'same@a.com', password: '123456' })
    logout()

    await expect(
      register({ username: 'baska', email: 'SAME@a.com', password: '123456' }),
    ).rejects.toThrow('kayıtlı')
  })

  it('fails login with wrong credentials', async () => {
    const { register, logout, login } = useAuthStore.getState()
    await register({ username: 'deniz', email: 'deniz@x.com', password: '123456' })
    logout()

    await expect(login('deniz', 'wrong')).rejects.toThrow('Hatalı şifre')
    await expect(login('nobody', '123456')).rejects.toThrow('Kullanıcı bulunamadı')
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('logs in with username or email', async () => {
    const { register, logout, login } = useAuthStore.getState()
    await register({ username: 'deniz', email: 'deniz@x.com', password: '123456' })
    logout()

    await login('deniz@x.com', '123456')
    expect(useAuthStore.getState().user?.username).toBe('deniz')
  })

  it('isolates the wallet per user across logins', async () => {
    const { register, login, logout } = useAuthStore.getState()

    await register({ username: 'alice', email: 'alice@x.com', password: '123456' })
    useTradeStore.getState().deposit(1000)
    expect(useTradeStore.getState().balance).toBe(1000)

    logout()
    useTradeStore.getState().resetWallet()
    expect(useTradeStore.getState().balance).toBe(0)

    await login('alice', '123456')
    await vi.waitFor(() => {
      expect(useTradeStore.getState().balance).toBe(1000)
    })
  })

  it('keeps saved cards after logout and reloads them on the next login', async () => {
    const { register, logout, login } = useAuthStore.getState()
    await register({ username: 'deniz', email: 'deniz@x.com', password: '123456' })

    const uid = useAuthStore.getState().user!.id
    saveCard({ holderName: 'DENIZ DEMO', number: '4242424242424242', expiry: '12/29' })
    expect(getSavedCards()).toHaveLength(1)

    // Logging out must only end the session — the user's stored data survives.
    logout()
    expect(localStorage.getItem(cardsStorageKeyFor(uid))).toBeTruthy()

    await login('deniz', '123456')
    const cards = getSavedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ holderName: 'DENIZ DEMO', number: '4242424242424242' })
  })

  it('rejects registration with an invalid referral code', async () => {
    const { register } = useAuthStore.getState()
    await expect(
      register({
        username: 'badref',
        email: 'badref@x.com',
        password: '123456',
        referralCode: 'rastgele-yazi',
      }),
    ).rejects.toThrow('Geçersiz referans kodu')
    expect(useAuthStore.getState().user).toBeNull()
    expect(localStorage.getItem('deniztradx_session')).toBeNull()
  })

  it('accepts registration with a valid referral code (no bonus credited)', async () => {
    const validCode = VALID_REFERRAL_CODES[0]
    const { register } = useAuthStore.getState()
    await register({
      username: 'goodref',
      email: 'goodref@x.com',
      password: '123456',
      referralCode: validCode.toUpperCase(),
    })

    expect(useAuthStore.getState().user?.username).toBe('goodref')
    expect(useTradeStore.getState().balance).toBe(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('accepts registration when the referral field is empty', async () => {
    const { register } = useAuthStore.getState()
    await register({ username: 'noref', email: 'noref@x.com', password: '123456' })
    expect(useAuthStore.getState().user?.username).toBe('noref')
    expect(useTradeStore.getState().balance).toBe(0)
  })
})