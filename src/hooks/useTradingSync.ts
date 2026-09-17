import { useEffect, useRef } from 'react'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { useTradeStore } from '@/store/tradeStore'
import { useOrderStore } from '@/store/orderStore'
import {
  loadTradingState,
  saveTradingState,
  type TradingSnapshot,
} from '@/services/tradingSyncService'

/**
 * Cihazlar arası işlem senkronu (App Shell'e takılır, girişliyken aktif).
 *
 * Ne yapar?
 *  - Mobilde açılan pozisyon / spot bakiye / bekleyen emir masaüstünde de
 *    görünür (ve tersi) — `trading_state` tek satırı üzerinden.
 *  - Bakiye bu yolla TAŞINMAZ (`profiles.balance` + useProfileSync'indir).
 *
 * Nasıl?
 *  - Yerel değişim → 2 sn debounce ile sunucuya yaz (son yazan kazanır).
 *  - Girişte: sunucu + yerel UNION ile birleşir (hiçbir cihazın işi
 *    kaybolmaz), sonuç yazılır.
 *  - Sonrasında: realtime/focus/online/polling ile sunucu çekilir; yalnızca
 *    kendi yazımızdan YENİ satırlar uygulanır (yankı/self-clobber yok).
 *  - Yerel hareketten sonraki 5 sn içinde gelen sunucu satırı atlanır
 *    (debounce'lu yazı tamamlanmadan eski değerle ezilme olmaz).
 */

const PUSH_DEBOUNCE_MS = 2000
const LOCAL_CHANGE_GUARD_MS = 5000
const POLL_MS = 15000

function snapshotOfLocal() {
  const t = useTradeStore.getState()
  const o = useOrderStore.getState()
  return {
    positions: t.positions,
    spotBalances: t.spotBalances,
    spotPositions: t.spotPositions,
    pendingOrders: o.pendingOrders,
    trades: t.trades,
    spotTrades: t.spotTrades,
  }
}

function unionById<T extends { id: string }>(primary: T[], secondary: T[], cap?: number): T[] {
  const seen = new Set(primary.map((x) => x.id))
  const out = [...primary]
  for (const x of secondary) {
    if (!seen.has(x.id)) {
      seen.add(x.id)
      out.push(x)
    }
  }
  return typeof cap === 'number' ? out.slice(0, cap) : out
}

function applySnapshot(snap: Omit<TradingSnapshot, 'updatedAt'>) {
  useTradeStore.getState().hydrateTradingState({
    positions: snap.positions,
    spotBalances: snap.spotBalances,
    spotPositions: snap.spotPositions,
    trades: snap.trades,
    spotTrades: snap.spotTrades,
  })
  useOrderStore.getState().hydrateOrders(snap.pendingOrders)
}

function isEmptySnap(s: {
  positions: unknown[]
  spotPositions: unknown[]
  pendingOrders: unknown[]
  trades: unknown[]
  spotTrades: unknown[]
  spotBalances: Record<string, number>
}): boolean {
  return (
    s.positions.length === 0 &&
    s.spotPositions.length === 0 &&
    s.pendingOrders.length === 0 &&
    s.trades.length === 0 &&
    s.spotTrades.length === 0 &&
    Object.keys(s.spotBalances).length === 0
  )
}

export function useTradingSync() {
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const refs = useRef({
    lastApplied: 0,
    lastPushAt: 0,
    lastLocalChange: 0,
    pushTimer: undefined as number | undefined,
    activeUid: null as string | null,
  })

  // Yerel değişimleri izle → debounce'lu push (yarış penceresi için damga).
  useEffect(() => {
    const schedule = () => {
      const st = refs.current
      const uid = st.activeUid
      if (!uid || !isSupabaseConfigured) return
      st.lastLocalChange = Date.now()
      window.clearTimeout(st.pushTimer)
      st.pushTimer = window.setTimeout(() => {
        void (async () => {
          const at = await saveTradingState(uid, snapshotOfLocal())
          if (at !== null) {
            st.lastPushAt = Date.now()
            st.lastApplied = Math.max(st.lastApplied, at)
          }
        })()
      }, PUSH_DEBOUNCE_MS)
    }
    const unsubTrade = useTradeStore.subscribe((s, prev) => {
      if (
        s.positions !== prev.positions ||
        s.spotBalances !== prev.spotBalances ||
        s.spotPositions !== prev.spotPositions ||
        s.trades !== prev.trades ||
        s.spotTrades !== prev.spotTrades
      ) {
        schedule()
      }
    })
    const unsubOrders = useOrderStore.subscribe((s, prev) => {
      if (s.pendingOrders !== prev.pendingOrders) schedule()
    })
    return () => {
      window.clearTimeout(refs.current.pushTimer)
      unsubTrade()
      unsubOrders()
    }
  }, [])

  useEffect(() => {
    const st = refs.current
    st.activeUid = userId
    st.lastApplied = 0
    st.lastPushAt = 0
    st.lastLocalChange = 0
    window.clearTimeout(st.pushTimer)
    if (!userId || !isSupabaseConfigured || !supabase) return
    const client = supabase
    const uid = userId
    let cancelled = false

    /** Sunucu satırını uygula — yankı ve yarış korumalı. */
    const applyIfFresh = (snap: TradingSnapshot) => {
      if (cancelled) return
      if (snap.updatedAt <= st.lastApplied) return
      // Kendi yazımızın yankısı ya da debounce bekleyen yerel iş: atla.
      if (Date.now() - st.lastPushAt < LOCAL_CHANGE_GUARD_MS) return
      if (Date.now() - st.lastLocalChange < LOCAL_CHANGE_GUARD_MS) return
      st.lastApplied = snap.updatedAt
      applySnapshot(snap)
    }

    const pull = () => {
      void loadTradingState(uid).then(applyIfFresh)
    }

    // Giriş senkronu: önce yerel persistler yüklensin, sonra UNION birleşme.
    void (async () => {
      try {
        await useTradeStore.persist.rehydrate()
      } catch {
        // yoksay — bellek durumu ile devam
      }
      try {
        await useOrderStore.persist.rehydrate()
      } catch {
        // yoksay
      }
      if (cancelled) return
      const server = await loadTradingState(uid)
      if (cancelled) return
      const local = snapshotOfLocal()
      if (server.updatedAt === 0) {
        // Sunucuda hiç satır yok: yerel doluysa ilk tohumu yaz.
        if (!isEmptySnap(local)) {
          const at = await saveTradingState(uid, local)
          if (at !== null) {
            st.lastPushAt = Date.now()
            st.lastApplied = at
          }
        }
        return
      }
      if (isEmptySnap(local)) {
        st.lastApplied = server.updatedAt
        applySnapshot(server)
        return
      }
      // İki tarafta da iş var: id-union ile birleştir, yaz.
      const merged = {
        positions: unionById(server.positions, local.positions),
        spotBalances: { ...local.spotBalances, ...server.spotBalances },
        spotPositions: unionById(server.spotPositions, local.spotPositions),
        pendingOrders: unionById(server.pendingOrders, local.pendingOrders),
        trades: unionById(server.trades, local.trades, 200),
        spotTrades: unionById(server.spotTrades, local.spotTrades, 200),
      }
      st.lastApplied = server.updatedAt
      applySnapshot(merged)
      const at = await saveTradingState(uid, merged)
      if (cancelled) return
      if (at !== null) {
        st.lastPushAt = Date.now()
        st.lastApplied = Math.max(st.lastApplied, at)
      }
    })()

    const channel = client
      .channel('trading-state-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trading_state', filter: `user_id=eq.${uid}` },
        pull,
      )
      .subscribe()
    const timer = window.setInterval(pull, POLL_MS)
    const onFocus = pull
    const onVisibility = () => {
      if (document.visibilityState === 'visible') pull()
    }
    const onOnline = pull
    const onPageShow = pull
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
      void client.removeChannel(channel)
    }
  }, [userId])
}
