import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'default' | 'buy' | 'sell' | 'ghost' | 'outline'
type Size = 'sm' | 'md' | 'lg'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

const variantClasses: Record<Variant, string> = {
  default: 'bg-exchange-yellow text-black hover:brightness-110',
  buy: 'bg-exchange-buy text-black hover:opacity-90',
  sell: 'bg-exchange-sell text-white hover:opacity-90',
  ghost: 'bg-transparent text-exchange-muted hover:bg-exchange-border/40 hover:text-exchange-text',
  outline: 'border border-exchange-border bg-transparent text-exchange-text hover:border-exchange-muted',
}

const sizeClasses: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-sm',
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  children,
  ...props
}: Props) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-exchange-yellow/60 disabled:cursor-not-allowed disabled:opacity-40',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}