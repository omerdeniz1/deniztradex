import { useRef, useState } from 'react'
import { useSettingsStore } from '@/store/settingsStore'
import { useAuthStore } from '@/store/authStore'
import { useToastStore } from '@/store/toastStore'
import { removeAvatarFile, uploadAvatarFile } from '@/services/supabaseWallet'
import { cn } from '@/lib/utils'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'

export function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme)
  const confirmOrders = useSettingsStore((s) => s.confirmOrders)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const setConfirmOrders = useSettingsStore((s) => s.setConfirmOrders)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-exchange-border px-4 py-5 sm:px-6 sm:py-6">
        <h1 className="text-lg font-bold text-exchange-text">Ayarlar</h1>
        <p className="text-xs text-exchange-muted">Görünüm ve işlem tercihleriniz</p>
      </div>

      <div className="w-full max-w-2xl space-y-4 px-4 py-4 sm:space-y-6 sm:px-6 sm:py-6">
        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Görünüm
          </h2>
          <p className="mt-1 text-xs text-exchange-muted">
            Uygulama genelinde kullanılacak tema.
          </p>
          <div className="mt-4 grid max-w-sm grid-cols-2 gap-3">
            <ThemeOption
              active={theme === 'dark'}
              title="Karanlık"
              preview="bg-[#0B0E14]"
              onClick={() => setTheme('dark')}
            />
            <ThemeOption
              active={theme === 'light'}
              title="Aydınlık"
              preview="bg-[#f7f8fa]"
              onClick={() => setTheme('light')}
            />
          </div>
        </section>

        <AvatarSection />

        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
                İşlem Tercihleri
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-exchange-muted">
                Emir onay pencereleri: kapalıyken emirler tek tıkla anında gönderilir
                (one-click trading). Açıkken her emirde onay istenir.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <span className={cn('text-xs font-semibold', confirmOrders ? 'text-exchange-text' : 'text-exchange-muted')}>
                {confirmOrders ? 'Onay isteniyor' : 'Tek tık'}
              </span>
              <Toggle
                checked={confirmOrders}
                onChange={setConfirmOrders}
                label="Emir onay pencereleri"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
function AvatarSection() {
  const user = useAuthStore((s) => s.user)
  const setAvatarUrl = useAuthStore((s) => s.setAvatarUrl)
  const pushToast = useToastStore((s) => s.push)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!user) return null
  const avatarUrl = user.avatarUrl ?? null

  const onPick = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    try {
      const url = await uploadAvatarFile(user.id, file)
      setAvatarUrl(url)
      pushToast({ message: 'Profil fotoğrafın güncellendi.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Fotoğraf yüklenemedi.', tone: 'error' })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onRemove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await removeAvatarFile(user.id)
      setAvatarUrl(null)
      pushToast({ message: 'Profil fotoğrafın kaldırıldı.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Fotoğraf silinemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-exchange-border bg-exchange-card p-5 sm:p-6">
      <h2 className="text-sm font-bold uppercase tracking-wide text-exchange-muted">
        Profil Fotoğrafı
      </h2>
      <p className="mt-1 text-xs text-exchange-muted">
        Fotoğrafın forumda ve menüde görünür. JPG, PNG, WEBP veya GIF — en fazla 2MB.
      </p>
      <div className="mt-4 flex items-center gap-4">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={`${user.username} profil fotoğrafı`}
            className="h-16 w-16 shrink-0 rounded-full border border-exchange-border object-cover"
          />
        ) : (
          <span
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-exchange-yellow/15 text-2xl font-extrabold text-exchange-yellow"
            aria-hidden
          >
            {(user.username.charAt(0) || '?').toUpperCase()}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            aria-label="Profil fotoğrafı seç"
            className="hidden"
            onChange={(e) => void onPick(e.target.files?.[0])}
          />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Yükleniyor…' : avatarUrl ? 'Değiştir' : 'Fotoğraf Yükle'}
          </Button>
          {avatarUrl && (
            <Button size="sm" variant="ghost" onClick={() => void onRemove()} disabled={busy}>
              Kaldır
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}

function ThemeOption({
  title,
  preview,
  active,
  onClick,
}: {
  title: string
  preview: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'overflow-hidden rounded-xl border p-2 text-left transition-colors',
        active
          ? 'border-exchange-yellow ring-2 ring-exchange-yellow/30'
          : 'border-exchange-border hover:border-exchange-muted',
      )}
    >
      <div className={cn('h-16 w-full rounded-lg border border-black/10', preview)}>
        <div className="flex flex-col gap-1 p-2">
          <div className="h-1.5 w-1/2 rounded bg-current opacity-40" />
          <div className="h-1.5 w-full rounded bg-current opacity-20" />
          <div className="h-1.5 w-3/4 rounded bg-current opacity-20" />
        </div>
      </div>
      <div className="mt-2 px-1 text-sm font-semibold text-exchange-text">{title}</div>
      {active && <div className="px-1 pb-1 text-[10px] uppercase text-exchange-yellow">Seçili</div>}
    </button>
  )
}