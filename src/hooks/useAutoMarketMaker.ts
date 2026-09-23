import { useEffect } from 'react'
import {
  getAutoBotConfig,
  runAutoBotTick,
  type AutoBotConfig,
} from '@/services/autoMarketMakerService'

/**
 * Otomatik piyasa botu döngüsü — uygulamanın HER yerinde arka planda çalışır.
 *
 * App Shell'e bir kez bağlanır: `intervalMs` + rastgele sapma (±%25) ile
 * tik atar, sanal havuzlarda küçük al-sat hamleleri yapar. Sekme gizliyken
 * tik atlanir (kaynak + havuz spam'i önlenir). Config her 60 sn'de bir
 * tazelenir — admin değişikliği tüm istemcilere yayılır.
 */
export function useAutoMarketMaker() {
  useEffect(() => {
    let live = true
    let timer: number | null = null
    let cfg: AutoBotConfig = { enabled: true, intervalMs: 12000, intensity: 'normal' }
    let ticksSinceRefresh = 0

    const schedule = () => {
      if (!live) return
      const jitter = 0.75 + Math.random() * 0.5
      timer = window.setTimeout(tick, cfg.intervalMs * jitter)
    }

    const tick = async () => {
      if (!live) return
      try {
        ticksSinceRefresh += 1
        // ~60 sn'de bir config tazele (5 tik × 12 sn).
        if (ticksSinceRefresh >= 5) {
          ticksSinceRefresh = 0
          try {
            cfg = await getAutoBotConfig()
          } catch {
            // eski config ile devam
          }
        }
        if (cfg.enabled && !document.hidden) {
          await runAutoBotTick(cfg.intensity)
        }
      } catch {
        // Bot hatası uygulamayı asla düşürmez.
      } finally {
        schedule()
      }
    }

    void getAutoBotConfig()
      .then((c) => {
        if (live) cfg = c
      })
      .catch(() => {})
      .finally(() => schedule())

    return () => {
      live = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])
}
