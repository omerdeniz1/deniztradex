import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface CustomSelectOption<V extends string> {
  v: V
  l: string
}

interface Props<V extends string> {
  value: V
  onChange: (value: V) => void
  options: CustomSelectOption<V>[]
  className?: string
  label?: string
}

export function CustomSelect<V extends string>({ value, onChange, options, className, label }: Props<V>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const current = options.find((o) => o.v === value)

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(className, 'flex items-center justify-between text-left')}
      >
        <span className="truncate text-exchange-text">{current ? current.l : ''}</span>
        <span className="ml-1 shrink-0 text-[10px] text-exchange-muted">
          {open ? '\u25b2' : '\u25bc'}
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 max-h-72 min-w-full overflow-y-auto rounded border border-exchange-border bg-exchange-surface shadow-2xl"
        >
          {options.map((o) => (
            <div
              key={o.v}
              role="option"
              aria-selected={o.v === value}
              onClick={() => {
                onChange(o.v)
                setOpen(false)
              }}
              className={cn(
                'cursor-pointer px-3 py-2 font-mono text-sm text-exchange-text hover:bg-exchange-border/30',
                o.v === value && 'text-exchange-yellow',
              )}
            >
              {o.l}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}