import { cn } from '@/lib/utils'

interface Props {
  className?: string
}

export function Logo({ className }: Props) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="text-2xl font-extrabold tracking-tight text-exchange-text">
        Deniz
        <span className="text-exchange-yellow">
          Trade
          <span style={{ position: 'relative', display: 'inline-block' }}>
            X
            <span
              style={{
                position: 'absolute',
                top: '-3px',
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: '7px',
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