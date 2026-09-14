import { NavLink } from 'react-router-dom'
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

export function BottomNav() {
  return (
    <nav
      aria-label="Mobil gezinme"
      className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-exchange-border bg-exchange-surface/95 pb-safe backdrop-blur md:hidden"
    >
      <div className="flex items-stretch justify-around">
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition-colors',
                isActive ? 'text-exchange-yellow' : 'text-exchange-muted hover:text-exchange-text',
              )
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}