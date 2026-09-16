import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  isAnnouncementVisible,
  listAnnouncements,
  type Announcement,
} from '@/services/announcementService'

/** Duyuru kimliği → ilk görülme zamanı (ms). 1 saat dolan bir daha gösterilmez. */
const SEEN_KEY = 'deniztradx_ann_seen'

function readSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeSeen(map: Record<string, number>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map))
  } catch {
    // gizli mod — kural yalnızca bellekte yaşar
  }
}

/**
 * Sistem duyuru bandı (yalnızca ana ekranda kullanılır).
 *
 * Kural: duyuru ilk görüldüğünde zamanı kaydedilir; çıkış + girişlerde
 * 1 saat boyunca tekrar gösterilir, süre dolunca bir daha gösterilmez.
 * X ile kapatma yalnızca o oturumda gizler (süre dolmadıysa sonraki
 * girişte tekrar gelir).
 */
export function AnnouncementBanner() {
  const [item, setItem] = useState<Announcement | null>(null)

  useEffect(() => {
    let live = true
    void listAnnouncements(1).then((list) => {
      if (!live) return
      const latest = list[0] ?? null
      if (!latest) return
      const seen = readSeen()
      const first = seen[latest.id] ?? null
      if (!isAnnouncementVisible(first, Date.now())) return
      if (first == null) {
        writeSeen({ ...seen, [latest.id]: Date.now() })
      }
      setItem(latest)
    })
    return () => {
      live = false
    }
  }, [])

  const dismiss = () => {
    setItem(null)
  }

  return (
    <AnimatePresence initial={false}>
      {item && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="shrink-0 overflow-hidden border-b border-exchange-yellow/30 bg-exchange-yellow/10"
        >
          <div className="flex items-start gap-2 px-3 py-2 sm:px-4">
            <span aria-hidden className="mt-0.5 shrink-0 text-sm">
              📢
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-extrabold text-exchange-text sm:text-sm">
                {item.title}
              </div>
              <p className="mt-0.5 line-clamp-2 break-words text-[11px] leading-relaxed text-exchange-text/90 sm:text-xs">
                {item.body}
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Duyuruyu kapat"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-exchange-muted transition-colors hover:bg-exchange-border/40 hover:text-exchange-text"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
