import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore, settingsStorageKeyFor } from '@/store/settingsStore'

const SESSION_USER = {
  id: 'usr_test_1',
  username: 'deniz',
  email: 'deniz@x.com',
  createdAt: 1,
}

describe('settingsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('deniztradx_session', JSON.stringify(SESSION_USER))
    useSettingsStore.getState().setTheme('dark')
    useSettingsStore.getState().setConfirmOrders(false)
  })

  it('defaults to dark theme and one-click trading', () => {
    const s = useSettingsStore.getState()
    expect(s.theme).toBe('dark')
    expect(s.confirmOrders).toBe(false)
  })

  it('updates theme and order-confirmation preference', () => {
    useSettingsStore.getState().setTheme('light')
    useSettingsStore.getState().setConfirmOrders(true)

    const s = useSettingsStore.getState()
    expect(s.theme).toBe('light')
    expect(s.confirmOrders).toBe(true)
  })

  it('persists settings under the logged-in user key', async () => {
    useSettingsStore.getState().setTheme('light')

    const raw = localStorage.getItem(settingsStorageKeyFor('usr_test_1'))
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).state.theme).toBe('light')
  })

  it('keeps settings isolated between users', async () => {
    useSettingsStore.getState().setTheme('light')
    expect(localStorage.getItem(settingsStorageKeyFor('usr_test_1'))).toBeTruthy()

    localStorage.setItem(
      'deniztradx_session',
      JSON.stringify({ id: 'usr_test_2', username: 'baska', email: 'b@x.com', createdAt: 2 }),
    )
    await useSettingsStore.persist.rehydrate()

    expect(localStorage.getItem(settingsStorageKeyFor('usr_test_2'))).toBeNull()
    expect(
      JSON.parse(localStorage.getItem(settingsStorageKeyFor('usr_test_1')) as string).state.theme,
    ).toBe('light')

    useSettingsStore.getState().setTheme('light')
    expect(localStorage.getItem(settingsStorageKeyFor('usr_test_2'))).toBeTruthy()
  })
})