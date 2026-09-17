import { useCallback, useEffect, useState } from 'react'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  listCoinNewsPublic,
  listCoinOverridesPublic,
} from '@/services/coinMetaService'
import type { CoinNewsItem, CoinStatus } from '@/services/adminService'

/**
 * Coin durum haritası (yükseltme/düşürme): symbol → status.
 * Piyasalar ve işlem ekranı buradan sıralama/rozete karar verir.
 * Realtime + odaklanma ile tazelenir (admin değişikliği anında yansır).
 */
export function useCoinOverrides() {
  const [overrides, setOverrides] = useState<Record<string, CoinStatus>>({})

  const refresh = useCallback(() => {
    void listCoinOverridesPublic().then((map) => setOverrides(map))
  }, [])

  useEffect(() => {
    refresh()
    if (!isSupabaseConfigured || !supabase) return
    const client = supabase
    const channel = client
      .channel('coin-overrides')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'coin_overrides' },
        refresh,
      )
      .subscribe()
    const onFocus = refresh
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(refresh, 60000)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      void client.removeChannel(channel)
    }
  }, [refresh])

  return overrides
}

/** Bir sembolün haberleri (işlem ekranı paneli için). */
export function useCoinNews(symbol: string, limit = 3) {
  const [news, setNews] = useState<CoinNewsItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    void listCoinNewsPublic(symbol, limit).then((list) => {
      if (live) {
        setNews(list)
        setLoading(false)
      }
    })
    return () => {
      live = false
    }
  }, [symbol, limit])

  return { news, loading }
}
