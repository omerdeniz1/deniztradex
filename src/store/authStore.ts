import { create } from 'zustand'
import {
  getSessionUser,
  login as serviceLogin,
  logout as serviceLogout,
  register as serviceRegister,
} from '@/services/authService'
import { getProfileBalance } from '@/services/supabaseWallet'
import { useSettingsStore } from '@/store/settingsStore'
import { useTradeStore } from '@/store/tradeStore'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  login: (identifier: string, password: string) => Promise<User>
  register: (input: {
    username: string
    email: string
    password: string
    referralCode?: string
  }) => Promise<User>
  logout: () => void
}

/** Best-effort: pull the wallet starting balance from supabase profiles. */
async function syncProfileBalance(userId: string) {
  const balance = await getProfileBalance(userId)
  if (typeof balance === 'number' && Number.isFinite(balance)) {
    useTradeStore.getState().setBalance(balance)
  }
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: getSessionUser(),

  login: async (identifier, password) => {
    const user = await serviceLogin(identifier, password)
    set({ user })
    void useTradeStore.persist.rehydrate()
    // The account's theme / confirmation preferences live under the user's
    // own storage key — reload them once the session is active.
    void useSettingsStore.persist.rehydrate()
    void syncProfileBalance(user.id)
    return user
  },

  register: async (input) => {
    const user = await serviceRegister(input)
    set({ user })
    // Fresh users have no persisted wallet yet.
    await useTradeStore.persist.rehydrate()
    void useSettingsStore.persist.rehydrate()
    void syncProfileBalance(user.id)
    return user
  },

  logout: () => {
    // Logging out ONLY ends the active session. The account's saved cards,
    // withdrawal methods, settings and wallet are stored under the user's own
    // key and must survive so they reappear after the next login.
    serviceLogout()
    set({ user: null })
    // Switch the logged-out UI back to default in-memory preferences without
    // touching the stored blob (these writes are no-ops without a session).
    useSettingsStore.setState({ theme: 'dark', confirmOrders: false })
    // Clear in-memory wallet without persisting (wallet storage is session-scoped).
    useTradeStore.getState().resetWallet()
  },
}))

export function useAuthUser(): User | null {
  return useAuthStore((s) => s.user)
}