import { create } from 'zustand'
import {
  getSessionUser,
  getLocalUserTag,
  login as serviceLogin,
  logout as serviceLogout,
  register as serviceRegister,
  changeUsername as serviceChangeUsername,
  changeUserTag as serviceChangeUserTag,
  updateSessionAvatarUrl,
} from '@/services/authService'
import { getProfileBalanceWithRetry, fetchUsedPromos, claimPromoRemote } from '@/services/supabaseWallet'
import { useSettingsStore } from '@/store/settingsStore'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore } from '@/store/dnzStore'
import { useOrderStore } from '@/store/orderStore'
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
  /** Profil fotoğrafı değişince oturumu + arayüzü tazeler. */
  setAvatarUrl: (url: string | null) => void
  /** Kullanıcı adı + forum etiketi değiştirir (Ayarlar ekranı). */
  changeUsername: (username: string, tag?: string) => Promise<User>
  /** Forum etiketini tek başına değiştirir (kullanıcı adı aynı kalır). */
  changeUserTag: (tag: string) => Promise<User>
}

/**
 * Best-effort: pull the wallet starting balance from supabase profiles.
 * The `profiles` row is created by the `handle_new_user` DB trigger right
 * after sign-up. Right after sign-in that row can briefly not be there yet —
 * `getProfileBalanceWithRetry` waits and retries (short backoff, ~2s cap)
 * instead of crashing or silently keeping a stale balance.
 *
 * Safe fallback contract: a missing/slow profile must NEVER lock the app or
 * sign the user out. `serviceLogin`/`serviceRegister` already return a User
 * built from verified `auth.users` data (see `getProfileWithFallback`), so
 * this sync only adjusts the wallet balance when a row is actually found and
 * otherwise keeps the persisted wallet / zero. It never throws and never
 * calls `logout()`.
 */
async function syncProfileBalance(userId: string): Promise<void> {
  try {
    const balance = await getProfileBalanceWithRetry(userId)
    if (typeof balance === 'number' && Number.isFinite(balance)) {
      useTradeStore.getState().setBalance(balance)
    }
  } catch {
    // Network/RLS hiccup — ignore. The session stays active with the
    // persisted wallet so the user can keep using the app.
  }
}

/**
 * Promosyon haklarını hesap bazında eşitler (cihazlar arası tek-kullanım):
 * 1) bu cihazda önceden yerel kullanılmış kodları sunucuya işaretler
 *    (migration öncesi dönemden kalan haklar korunur),
 * 2) sunucudaki (başka cihazlarda kullanılmış) kodları bakiye işlemeden
 *    yerel listeye ekler.
 */
async function syncPromosWithSupabase(userId: string): Promise<void> {
  try {
    for (const code of useTradeStore.getState().promos) {
      await claimPromoRemote(userId, code)
    }
    const remote = await fetchUsedPromos(userId)
    if (remote.length > 0) {
      useTradeStore.getState().syncPromos(remote)
    }
  } catch {
    // best effort — yerel liste zaten girişi engeller
  }
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: getSessionUser(),

  login: async (identifier, password) => {
    const logged = await serviceLogin(identifier, password)
    // Yerel mod etiketi oturuma işle (Supabase modunda servisten gelir).
    const localTag = !logged.userTag ? getLocalUserTag(logged.id) : null
    const user = localTag ? { ...logged, userTag: localTag } : logged
    set({ user })
    // Yerel cüzdan (ve yerel promo listesi) önce yüklensin ki sunucuyla
    // eşitlerken migration-öncesi haklar kaybolmasın.
    await useTradeStore.persist.rehydrate()
    try {
      await useOrderStore.persist.rehydrate()
    } catch {
      // yoksay — bekleyen emir yok sayılır
    }
    // The account's theme / confirmation preferences live under the user's
    // own storage key — reload them once the session is active.
    void useSettingsStore.persist.rehydrate()
    await syncProfileBalance(user.id)
    await syncPromosWithSupabase(user.id)
    return user
  },

  register: async (input) => {
    const user = await serviceRegister(input)
    set({ user })
    // Fresh users have no persisted wallet yet.
    await useTradeStore.persist.rehydrate()
    void useSettingsStore.persist.rehydrate()
    await syncProfileBalance(user.id)
    await syncPromosWithSupabase(user.id)
    return user
  },

  logout: () => {
    // Logging out ONLY ends the active session. The account's saved cards,
    // withdrawal methods, settings and wallet are stored under the user's own
    // key and must survive so they reappear after the next login.
    // `serviceLogout` yerel oturumu SENKRON temizler (ilk await öncesi),
    // Supabase signOut'u arka planda tamamlar; hızlı çıkış->giriş
    // sıralamasını login içindeki `pendingSignOut` beklemesi korur
    // (Safari yarış durumu fix'i).
    void serviceLogout()
    set({ user: null })
    // Switch the logged-out UI back to default in-memory preferences without
    // touching the stored blob (these writes are no-ops without a session).
    useSettingsStore.setState({ theme: 'dark', confirmOrders: false })
    // Clear in-memory wallet without persisting (wallet storage is session-scoped).
    useTradeStore.getState().resetWallet()
    useDnzStore.getState().resetDnz()
    useOrderStore.getState().resetOrders()
  },

  setAvatarUrl: (url) => {
    updateSessionAvatarUrl(url)
    set({ user: getSessionUser() })
  },

  changeUsername: async (username, tag) => {
    const updated = await serviceChangeUsername(username, tag)
    // Yerel modda etiket ayrı anahtarda durur — oturuma işle.
    const localTag = getLocalUserTag(updated.id)
    set({ user: localTag && !updated.userTag ? { ...updated, userTag: localTag } : updated })
    return updated
  },

  changeUserTag: async (tag) => {
    const updated = await serviceChangeUserTag(tag)
    set({ user: updated })
    return updated
  },
}))

export function useAuthUser(): User | null {
  return useAuthStore((s) => s.user)
}