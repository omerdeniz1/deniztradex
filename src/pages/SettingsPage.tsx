import { useSettingsStore } from '@/store/settingsStore'
import { cn } from '@/lib/utils'
import { Toggle } from '@/components/ui/Toggle'

export function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme)
  const confirmOrders = useSettingsStore((s) => s.confirmOrders)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const setConfirmOrders = useSettingsStore((s) => s.setConfirmOrders)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-exchange-border px-6 py-6">
        <h1 className="text-lg font-bold text-exchange-text">Ayarlar</h1>
        <p className="text-xs text-exchange-muted">Görünüm ve işlem tercihleriniz</p>
      </div>

      <div className="max-w-2xl space-y-6 px-6 py-6">
        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-6">
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
              preview="bg-[#0b0e11]"
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

        <section className="rounded-2xl border border-exchange-border bg-exchange-card p-6">
          <div className="flex items-start justify-between gap-6">
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