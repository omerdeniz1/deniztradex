import { cn } from '@/lib/utils'

/**
 * Varsayılan profil fotoğrafı: insan silüeti.
 *
 * `avatarUrl` yoksa (botlar dahil tüm varsayılan hesaplar) baş harf yerine
 * bu silüet gösterilir — kullanıcı isteği: bot profilleri default olacak.
 */
export function DefaultAvatar({
  size = 'md',
  className,
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}) {
  const dims =
    size === 'xs'
      ? 'h-7 w-7'
      : size === 'sm'
        ? 'h-8 w-8'
        : size === 'lg'
          ? 'h-16 w-16'
          : 'h-9 w-9'
  const icon =
    size === 'xs'
      ? 14
      : size === 'sm'
        ? 16
        : size === 'lg'
          ? 32
          : 18
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-exchange-yellow',
        dims,
        className,
      )}
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4.42 0-8 2.24-8 5v1.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V19c0-2.76-3.58-5-8-5Z" />
      </svg>
    </span>
  )
}
