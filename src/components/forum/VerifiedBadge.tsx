/**
 * Resmi onay rozeti: gold → altın sarısı tik (süper admin / sistem hesabı),
 * blue → mavi tik (izinli alt yönetici). Renkler bilerek tema token'ı değil
 * sabit markadır (temadaki `exchange-yellow` camgöbeğidir).
 * Rozet kararı sunucudan gelir; bu bileşen yalnızca çizer.
 */
export function VerifiedBadge({ small, tone }: { small?: boolean; tone: 'gold' | 'blue' }) {
  const size = small ? 13 : 15
  return (
    <span
      role="img"
      aria-label="Onaylı hesap"
      title="Onaylı hesap"
      className="inline-flex shrink-0 items-center"
      style={{ color: tone === 'gold' ? '#ffc107' : '#1d9bf0' }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
      >
        <path d="M12 1.8 14.5 4l3.3-.5.9 3.2 3 1.5-1.4 3 1.4 3-3 1.5-.9 3.2-3.3-.5L12 22.2 9.5 20l-3.3.5-.9-3.2-3-1.5 1.4-3-1.4-3 3-1.5.9-3.2 3.3.5L12 1.8Z" />
        <path
          d="M10.6 14.6 8.4 12.4l-1.1 1.1 3.3 3.3 6-6-1.1-1.1-5 4.9Z"
          fill="#0a0a0a"
        />
      </svg>
    </span>
  )
}
