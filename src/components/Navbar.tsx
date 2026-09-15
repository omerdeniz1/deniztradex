import { useEffect, useRef, useState } from 'react'
import { NavLink, Link, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useAuthStore } from '@/store/authStore'
import { useUiStore } from '@/store/uiStore'
import { cn, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Logo } from '@/components/ui/Logo'

interface Props {
  balance: number
  username: string
}

const NAV_ITEMS = [
  { to: '/', label: 'Ana Sayfa', end: true },
  { to: '/markets', label: 'Piyasalar', end: false },
  { to: '/spot', label: 'Al-Sat', end: false },
  { to: '/futures', label: 'Vadeli', end: false },
] as const

export function Navbar({ balance, username }: Props) {
  const openWithdraw = useUiStore((s) => s.openWithdraw)

  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-exchange-border bg-exchange-surface px-3 pt-safe sm:gap-3 sm:px-4 md:h-14">
      <Link
        to="/"
        title="Ana Sayfa"
        aria-label="DenizTradeX ana sayfa"
        className="shrink-0 cursor-pointer rounded-lg transition-opacity hover:opacity-80"
      >
        <Logo className="[&>span]:text-xl [&>span]:sm:text-2xl" />
      </Link>

      <nav className="hidden min-w-0 items-center gap-1 md:flex">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors',
                isActive
                  ? 'bg-exchange-yellow/12 text-exchange-yellow'
                  : 'text-exchange-muted hover:bg-exchange-border/30 hover:text-exchange-text',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
        <div className="hidden text-right sm:block">
          <div className="text-[10px] uppercase text-exchange-muted">Bakiye</div>
          <div className="whitespace-nowrap font-mono text-sm font-bold">
            {formatNumber(balance, 2)} <span className="text-exchange-yellow">USDT</span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={openWithdraw} className="whitespace-nowrap px-2.5 sm:px-3">
          - Para Çek
        </Button>
        <UserMenu username={username} />
      </div>
    </header>
  )
}

function UserMenu({ username }: { username: string }) {
  const [open, setOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const logout = useAuthStore((s) => s.logout)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }

  return (
    <div ref={scopeRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-exchange-border/30"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-exchange-yellow text-xs font-extrabold text-black">
          {username.charAt(0).toUpperCase()}
        </span>
        <span className="hidden text-sm font-semibold text-exchange-text sm:block">{username}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className={cn('text-exchange-muted transition-transform', open && 'rotate-180')}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            role="menu"
            className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-xl border border-exchange-border bg-exchange-card shadow-2xl"
          >
            <div className="border-b border-exchange-border px-4 py-2.5 text-xs text-exchange-muted">
              <div className="font-medium text-exchange-text">{username}</div>
              <div>DenizTradeX hesabı</div>
            </div>
            <MenuItem label="Cüzdan" onClick={() => go('/wallet')} icon="👛" />
            <MenuItem label="Ayarlar" onClick={() => go('/settings')} icon="⚙️" />
            <div className="border-t border-exchange-border" />
            <MenuItem
              label="Çıkış Yap"
              onClick={() => {
                setOpen(false)
                logout()
              }}
              icon="⎋"
              danger
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  icon,
  danger,
}: {
  label: string
  onClick: () => void
  icon?: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-exchange-surface',
        danger ? 'text-exchange-sell hover:text-exchange-sell' : 'text-exchange-text',
      )}
    >
      <span className="w-4 text-center text-xs">{icon}</span>
      {label}
    </button>
  )
}