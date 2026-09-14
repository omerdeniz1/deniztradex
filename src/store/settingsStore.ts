import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getSessionUserId } from '@/services/authService'

export type Theme = 'dark' | 'light'

interface SettingsState {
  theme: Theme
  /** When true, orders open a confirmation dialog before being sent. */
  confirmOrders: boolean
  setTheme: (theme: Theme) => void
  setConfirmOrders: (value: boolean) => void
}

export const SETTINGS_STORAGE_KEY = 'deniztradx_settings'

export function settingsStorageKeyFor(userId: string): string {
  return `${SETTINGS_STORAGE_KEY}_${userId}`
}

/**
 * Storage adapter that scopes the settings blob to the currently logged-in
 * user. Every settings change is written under `${BASE}_${userId}`, and the
 * key made with the current session, so logging in as another account loads
 * that account's own theme / confirmation preferences.
 */
function scopedSettingsStorage() {
  return {
    getItem: () => {
      const uid = getSessionUserId()
      if (!uid) return null
      return localStorage.getItem(settingsStorageKeyFor(uid))
    },
    setItem: (_name: string, value: string) => {
      const uid = getSessionUserId()
      if (!uid) return
      localStorage.setItem(settingsStorageKeyFor(uid), value)
    },
    removeItem: () => {
      const uid = getSessionUserId()
      if (!uid) return
      localStorage.removeItem(settingsStorageKeyFor(uid))
    },
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      confirmOrders: false,
      setTheme: (theme) => set({ theme }),
      setConfirmOrders: (confirmOrders) => set({ confirmOrders }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => scopedSettingsStorage()),
    },
  ),
)