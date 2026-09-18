import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

const ITEMS = [
  {
    to: '/',
    label: 'Ana Sayfa',
    end: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 9.5V21h14V9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/markets',
    label: 'Piyasalar',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/spot',
    label: 'Al-Sat',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 17V7m0 0L4 10m3-3 3 3M17 7v10m0 0 3-3m-3 3-3-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/futures',
    label: 'Vadeli',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 17l5-6 4 3 7-8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 6h4v4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/wallet',
    label: 'Cüzdan',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 12h.01" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
] as const

/** Menü sayfası (Etkinlik + Transfer + Forum + Sıralama) alt bardaki Menü düğmesinden açılır. */
const MENU_LINKS = [
  {
    to: '/transfer',
    label: 'Transfer',
    hint: 'Hesaplar arası gönderim',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 17V7m0 0L4 10m3-3 3 3M17 7v10m0 0 3-3m-3 3-3-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/events',
    label: 'Etkinlik',
    hint: 'Yarışmalar ve ödüller',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/forum',
    label: 'Forum',
    hint: 'Topluluk akışı',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/leaderboard',
    label: 'Sıralama',
    hint: 'Trader Skoru liderliği',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M8 21h8M12 17v4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 6H4.5A1.5 1.5 0 0 0 3 7.5C3 9.4 4.6 11 7 11M17 6h2.5A1.5 1.5 0 0 1 21 7.5C21 9.4 19.4 11 17 11" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
] as const

export function BottomNav() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const sheetRef = useRef<HTMLDivElement>(null)

  // Menüdeki sayfalardan birindeyken Menü düğmesi aktif görünür.
  const menuActive =
    location.pathname === '/forum' ||
    location.pathname === '/leaderboard' ||
    location.pathname === '/events' ||
    location.pathname === '/transfer'

  // Rota değişince (örn. geri tuşu) açık menüyü kapat.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  const go = (to: string) => {
    setMenuOpen(false)
    navigate(to)
  }

  return (
    <>
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              aria-hidden
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px] md:hidden"
            />
            <motion.div
              ref={sheetRef}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 350 }}
              role="menu"
              aria-label="Menü"
              className="fixed inset-x-0 bottom-0 z-[61] rounded-t-2xl border-t border-exchange-border bg-exchange-card px-4 pb-safe pt-2 shadow-2xl md:hidden"
            >
              <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-exchange-border" aria-hidden />
              {MENU_LINKS.map((item) => {
                const active = location.pathname === item.to
                return (
                  <button
                    key={item.to}
                    type="button"
                    role="menuitem"
                    onClick={() => go(item.to)}
                    className={cn(
                      'mb-2 flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors active:scale-[0.98] last:mb-4',
                      active
                        ? 'border-exchange-yellow/50 bg-exchange-yellow/10'
                        : 'border-exchange-border bg-exchange-surface',
                    )}
                  >
                    <span className={cn('shrink-0', active ? 'text-exchange-yellow' : 'text-exchange-muted')} aria-hidden>
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm font-bold', active ? 'text-exchange-yellow' : 'text-exchange-text')}>
                        {item.label}
                      </span>
                      <span className="block truncate text-[11px] text-exchange-muted">
                        {item.hint}
                      </span>
                    </span>
                  </button>
                )
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <nav
        aria-label="Mobil gezinme"
        className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-exchange-border bg-exchange-surface/95 px-safe pb-safe backdrop-blur md:hidden"
      >
        <div className="flex w-full items-stretch justify-around">
          {ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-[3.75rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-semibold transition-colors active:scale-95',
                  isActive ? 'text-exchange-yellow' : 'text-exchange-muted hover:text-exchange-text',
                )
              }
            >
              {item.icon}
              <span className="w-full truncate px-0.5 text-center">{item.label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Menü"
            className={cn(
              'flex min-h-[3.75rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-semibold transition-colors active:scale-95',
              menuOpen || menuActive
                ? 'text-exchange-yellow'
                : 'text-exchange-muted hover:text-exchange-text',
            )}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            <span className="w-full truncate px-0.5 text-center">Menü</span>
          </button>
        </div>
      </nav>
    </>
  )
}
