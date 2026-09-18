import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSettingsStore } from '@/store/settingsStore'
import { useAuthStore } from '@/store/authStore'
import { useToastStore } from '@/store/toastStore'
import { changePassword } from '@/services/authService'
import { removeAvatarFile, uploadAvatarFile } from '@/services/supabaseWallet'
import { cn } from '@/lib/utils'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'
import { DefaultAvatar } from '@/components/forum/DefaultAvatar'

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

        <UsernameSection />

        <PasswordSection />

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
        Fotoğrafın forumda ve menüde görünür. JPG, PNG, WEBP veya GIF — en fazla 10MB.
      </p>
      <div className="mt-4 flex items-center gap-4">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={`${user.username} profil fotoğrafı`}
            className="h-16 w-16 shrink-0 rounded-full border border-exchange-border object-cover"
          />
        ) : (
          <DefaultAvatar size="lg" />
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

function UsernameSection() {
  const user = useAuthStore((s) => s.user)
  const changeUsername = useAuthStore((s) => s.changeUsername)
  const changeUserTag = useAuthStore((s) => s.changeUserTag)
  const pushToast = useToastStore((s) => s.push)
  const [name, setName] = useState(user?.username ?? '')
  const [tag, setTag] = useState(user?.userTag ?? '')
  const [busyName, setBusyName] = useState(false)
  const [busyTag, setBusyTag] = useState(false)
  // Şifre menüsüyle aynı açılır yapı.
  const [open, setOpen] = useState(false)

  if (!user) return null

  const onSaveName = async () => {
    if (busyName) return
    const nextName = name.trim()
    if (!nextName) {
      pushToast({ message: 'Kullanıcı adı boş olamaz.', tone: 'error' })
      return
    }
    setBusyName(true)
    try {
      await changeUsername(nextName)
      pushToast({ message: 'Kullanıcı adın güncellendi. Eski adın yeniden kayda açıldı.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Güncellenemedi.', tone: 'error' })
    } finally {
      setBusyName(false)
    }
  }

  const onSaveTag = async () => {
    if (busyTag) return
    setBusyTag(true)
    try {
      await changeUserTag(tag)
      pushToast({ message: tag.trim() ? 'Etiketin güncellendi.' : 'Etiketin kaldırıldı.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Güncellenemedi.', tone: 'error' })
    } finally {
      setBusyTag(false)
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="username-body"
        className="flex w-full items-center gap-3 p-5 text-left transition-colors active:scale-[0.99] sm:p-6"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Kullanıcı Adı Değiştir
          </span>
          <span className="mt-1 block truncate text-xs text-exchange-muted">
            <span className="font-bold text-exchange-text">{user.username}</span>
            {user.userTag ? (
              <span className="ml-1.5 rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-bold text-exchange-yellow">
                {user.userTag}
              </span>
            ) : (
              ' — forum etiketin yok'
            )}
          </span>
        </span>
        <span
          aria-hidden
          className={cn('shrink-0 text-xs text-exchange-muted transition-transform', open && 'rotate-180')}
        >
          ▼
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="username-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="grid gap-3 px-5 pb-5 sm:px-6 sm:pb-6">
              <div className="min-w-0 rounded-xl border border-exchange-border/60 p-3">
                <label htmlFor="username-next" className="mb-1 block text-xs font-semibold text-exchange-muted">
                  Yeni kullanıcı adı (en az 3 karakter)
                </label>
                <input
                  id="username-next"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={20}
                  autoComplete="username"
                  disabled={busyName}
                  placeholder={user.username}
                  className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
                />
                <div className="mt-2">
                  <Button size="sm" onClick={() => void onSaveName()} disabled={busyName}>
                    {busyName ? 'Güncelleniyor…' : 'Kullanıcı Adını Güncelle'}
                  </Button>
                </div>
              </div>
              <div className="min-w-0 rounded-xl border border-exchange-border/60 p-3">
                <label htmlFor="username-tag" className="mb-1 block text-xs font-semibold text-exchange-muted">
                  Forum etiketi (isim altında görünür — ad değişmeden tek başına kaydedilir, en fazla 24 karakter)
                </label>
                <input
                  id="username-tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  maxLength={24}
                  disabled={busyTag}
                  placeholder="örn. Balina, Analist, Fenomen"
                  className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
                />
                {tag.trim() && (
                  <p className="mt-1.5 text-xs text-exchange-muted">
                    Önizleme:{' '}
                    <span className="font-bold text-exchange-text">{user.username}</span>{' '}
                    <span className="rounded-full bg-exchange-yellow/15 px-2 py-0.5 text-[10px] font-bold text-exchange-yellow">
                      {tag.trim().slice(0, 24)}
                    </span>
                  </p>
                )}
                <div className="mt-2">
                  <Button size="sm" onClick={() => void onSaveTag()} disabled={busyTag}>
                    {busyTag ? 'Kaydediliyor…' : 'Etiketi Kaydet'}
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

function PasswordSection() {
  const user = useAuthStore((s) => s.user)
  const pushToast = useToastStore((s) => s.push)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  // Menü gibi kapalı başlar; tıklayınca değiştirme kutuları açılır.
  const [open, setOpen] = useState(false)

  if (!user) return null

  const onSave = async () => {
    if (busy) return
    if (!current || !next || !confirm) {
      pushToast({ message: 'Tüm şifre alanlarını doldur.', tone: 'error' })
      return
    }
    if (next !== confirm) {
      pushToast({ message: 'Yeni şifreler birbiriyle eşleşmiyor.', tone: 'error' })
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      pushToast({ message: 'Şifren güncellendi.', tone: 'success' })
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Şifre güncellenemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const fields = [
    { id: 'pw-current', label: 'Mevcut şifre', value: current, set: setCurrent, auto: 'current-password' },
    { id: 'pw-next', label: 'Yeni şifre (en az 6 karakter)', value: next, set: setNext, auto: 'new-password' },
    { id: 'pw-confirm', label: 'Yeni şifre (tekrar)', value: confirm, set: setConfirm, auto: 'new-password' },
  ] as const

  return (
    <section className="overflow-hidden rounded-2xl border border-exchange-border bg-exchange-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="pw-body"
        className="flex w-full items-center gap-3 p-5 text-left transition-colors active:scale-[0.99] sm:p-6"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold uppercase tracking-wide text-exchange-muted">
            Şifre Değiştir
          </span>
          <span className="mt-1 block text-xs text-exchange-muted">
            Hesabının şifresini güncelle. Değişiklik anında geçerli olur.
          </span>
        </span>
        <span
          aria-hidden
          className={cn('shrink-0 text-xs text-exchange-muted transition-transform', open && 'rotate-180')}
        >
          ▼
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="pw-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
      <div className="grid gap-3 px-5 pb-5 sm:px-6 sm:pb-6">
        {fields.map((f) => (
          <div key={f.id} className="min-w-0">
            <label htmlFor={f.id} className="mb-1 block text-xs font-semibold text-exchange-muted">
              {f.label}
            </label>
            <input
              id={f.id}
              type={show ? 'text' : 'password'}
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              autoComplete={f.auto}
              disabled={busy}
              className="h-11 w-full min-w-0 rounded-xl border border-exchange-border bg-exchange-bg px-3 text-sm text-exchange-text outline-none focus:border-exchange-yellow disabled:opacity-50 placeholder:text-exchange-muted/70"
            />
          </div>
        ))}
        <label className="flex cursor-pointer items-center gap-2.5 text-xs font-semibold text-exchange-muted">
          <input
            type="checkbox"
            checked={show}
            onChange={(e) => setShow(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-yellow-400"
          />
          Şifreleri göster
        </label>
        <div>
          <Button size="md" onClick={() => void onSave()} disabled={busy}>
            {busy ? 'Güncelleniyor…' : 'Şifreyi Güncelle'}
          </Button>
        </div>
      </div>
          </motion.div>
        )}
      </AnimatePresence>
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