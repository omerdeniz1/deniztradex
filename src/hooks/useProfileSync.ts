import { useCallback, useEffect, useRef } from 'react'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { useTradeStore } from '@/store/tradeStore'
import { useToastStore } from '@/store/toastStore'
import { getProfile } from '@/services/supabaseWallet'
import { formatNumber } from '@/lib/utils'

/**
 * Profil canlı senkronu (App Shell'e takılır, girişliyken aktiftir).
 *
 * Ne yapar?
 *  - Yönetici bakiyeyi değiştirince kullanıcının ekranı ANINDA güncellenir
 *    (tutar yönüyle birlikte bilgi verilir) — çıkış-giriş gerekmez.
 *  - Hesap dondurulur/yasaklanırsa oturum anında kapatılır.
 *  - Profil fotoğrafı değişirse menüdeki avatar tazelenir.
 *
 * Nasıl?
 *  - Birincil kanal realtime'dır (kendi satırındaki UPDATE olayı).
 *  - Yedek: 12 sn yoklama + odaklanınca/ağ dönünce kontrol.
 *
 * Yarış koruması: yerel bakiye hareketinden sonraki 8 sn içinde gelen
 * sunucu değeri uygulanmaz (işlemin kendi senkronu tamamlanmadan eski
 * değerle ezilme olmaz); baz korunur, sonraki tur yakalar.
 */
export function useProfileSync() {
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const pushToast = useToastStore((s) => s.push)

  const stateRef = useRef<{ lastServer: number | null; lastLocalChange: number }>({
    lastServer: null,
    lastLocalChange: 0,
  })

  // Yerel bakiye hareketlerini izle (yarış penceresi koruması için).
  useEffect(() => {
    const unsub = useTradeStore.subscribe((s, prev) => {
      if (s.balance !== prev.balance) {
        stateRef.current.lastLocalChange = Date.now()
      }
    })
    return unsub
  }, [])

  const check = useCallback(async () => {
    const uid = useAuthStore.getState().user?.id ?? null
    if (!uid || !isSupabaseConfigured || !supabase) return
    let profile
    try {
      profile = await getProfile(uid)
    } catch {
      return
    }
    if (!profile) return
    const st = stateRef.current

    if (profile.is_banned === true || profile.is_frozen === true) {
      pushToast({
        message:
          profile.is_banned === true
            ? 'Hesabın yasaklanmış. Destek ile iletişime geç.'
            : 'Hesabın dondurulmuş. Destek ile iletişime geç.',
        tone: 'error',
      })
      useAuthStore.getState().logout()
      return
    }

    const sessionAvatar = useAuthStore.getState().user?.avatarUrl ?? null
    if ((profile.avatar_url ?? null) !== sessionAvatar) {
      useAuthStore.getState().setAvatarUrl(profile.avatar_url ?? null)
    }

    const server = profile.balance
    if (st.lastServer === null) {
      // İlk okuma sessiz eşitler (giriş senkronu sonrası genelde aynıdır).
      st.lastServer = server
      if (useTradeStore.getState().balance !== server) {
        useTradeStore.getState().setBalance(server)
      }
      return
    }
    if (server === st.lastServer) return
    // Yerel hareket varsa bu tur atla (baz korunur, sonraki tur yakalar).
    if (Date.now() - st.lastLocalChange < 8000) return
    st.lastServer = server

    const local = useTradeStore.getState().balance
    if (local === server) return
    useTradeStore.getState().setBalance(server)
    const diff = server - local
    pushToast({
      message:
        diff > 0
          ? `Bakiyene +${formatNumber(diff, 2)} USDT eklendi.`
          : `Bakiyenden ${formatNumber(Math.abs(diff), 2)} USDT düşüldü.`,
      tone: 'info',
    })
  }, [pushToast])

  useEffect(() => {
    stateRef.current.lastServer = null
    if (!userId || !isSupabaseConfigured || !supabase) return
    const client = supabase
    const quiet = () => {
      void check()
    }
    void check()
    const channel = client
      .channel('profile-sync')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        quiet,
      )
      .subscribe()
    const timer = window.setInterval(quiet, 12000)
    const onFocus = quiet
    const onVisibility = () => {
      if (document.visibilityState === 'visible') quiet()
    }
    const onPageShow = quiet
    const onOnline = quiet
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('online', onOnline)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('online', onOnline)
      void client.removeChannel(channel)
    }
  }, [userId, check])
}
