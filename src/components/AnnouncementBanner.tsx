import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { listAnnouncements, type Announcement } from '@/services/announcementService'

const DISMISS_KEY = 'deniztradx_ann_dismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY)
  } catch {
    return null
  }
}

function writeDismissed(id: string) {
  try {
    localStorage.setItem(DISMISS_KEY, id)
  } catch {
    // gizli mod — kapatma yalnızca bellekte yaşar
  }
}

/**
 * Sistem duyuru bandı: süper adminin yayınladığı en güncel duyuruyu
 * tüm sayfaların üstünde gösterir. Kullanıcı kapatınca o duyuru için
 * bir daha gösterilmez (yeni duyuruda bant geri gelir).
 */
export function AnnouncementBanner() {
  const [item, setItem] = useState<Announcement | null>(null)

  useEffect(() => {
    let live = true
    void listAnnouncements(1).then((list) => {
      if (!live) return
      const latest = list[0] ?? null
      if (latest && readDismissed() !== latest.id) {
        setItem(latest)
      }
    })
    return () => {
      live = false
    }
  }, [])

  const dismiss = () => {
    if (item) writeDismissed(item.id)
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
