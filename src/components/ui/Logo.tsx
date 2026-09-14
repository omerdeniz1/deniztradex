import { cn } from '@/lib/utils'

interface Props {
  className?: string
  iconClassName?: string
}

export function Logo({ className, iconClassName }: Props) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden className={iconClassName}>
        <rect width="64" height="64" rx="14" fill="#132026" />
        <path
          d="M20 46 L32 22 L44 46"
          stroke="#f0b90b"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M26 38 L38 38" stroke="#f0b90b" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <span className="text-lg font-extrabold tracking-tight text-exchange-text">
        Deniz
        <span className="text-exchange-yellow">
          Trade
          <span style={{ position: 'relative', display: 'inline-block' }}>
            X
            <span
              style={{
                position: 'absolute',
                top: '-2px',
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: '5px',
                lineHeight: '1',
                fontWeight: 700,
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
              }}
            >
              BETA
            </span>
          </span>
        </span>
      </span>
    </div>
  )
}