import { AnimatePresence, motion } from 'framer-motion'
import { useToastStore } from '@/store/toastStore'
import { cn } from '@/lib/utils'

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed right-4 top-16 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl backdrop-blur',
              t.tone === 'success' &&
                'border-exchange-buy/50 bg-exchange-buy/10 text-exchange-buy',
              t.tone === 'error' && 'border-exchange-sell/50 bg-exchange-sell/10 text-exchange-sell',
              t.tone === 'info' && 'border-exchange-muted/40 bg-exchange-surface/95 text-exchange-text',
            )}
          >
            <span className="flex-1 leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Toast'u kapat"
              className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
            >
              ✕
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}