import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAuthStore } from '@/store/authStore'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

type Mode = 'login' | 'register'

export function AuthScreen() {
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)

  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [referralCode, setReferralCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const switchMode = (next: Mode) => {
    if (mode === next) return
    setMode(next)
    setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    setError(null)

    if (mode === 'register' && password !== passwordConfirm) {
      setError('Şifreler birbiriyle eşleşmiyor.')
      return
    }

    setLoading(true)
    try {
      if (mode === 'login') {
        await login(identifier, password)
      } else if (mode === 'register') {
        // An invalid referral code is rejected inside authService.register and
        // surfaces here as a red in-form error.
        await register({ username, email, password, referralCode })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bir hata oluştu.')
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'h-11 w-full rounded-lg border border-exchange-border bg-exchange-bg px-3.5 text-base text-exchange-text outline-none transition-colors focus:border-exchange-yellow placeholder:text-exchange-muted/70 sm:text-sm'

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-y-auto overflow-x-clip bg-exchange-bg p-4 py-8 sm:py-4">
      {/* ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-exchange-yellow/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-72 w-72 rounded-full bg-exchange-buy/10 blur-3xl"
      />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="relative w-full max-w-md"
      >
        <div className="mb-6 flex justify-center">
          <Logo iconClassName="h-10 w-10" />
        </div>

        <div className="rounded-2xl border border-exchange-border bg-exchange-card p-5 shadow-2xl sm:p-8">
          <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-exchange-bg p-1">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={cn(
                  'rounded-lg py-2 text-sm font-semibold transition-colors',
                  mode === m
                    ? 'bg-exchange-yellow text-black'
                    : 'text-exchange-muted hover:text-exchange-text',
                )}
              >
                {m === 'login' ? 'Giriş Yap' : 'Kayıt Ol'}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.form
              key={mode}
              initial={{ opacity: 0, x: mode === 'login' ? 16 : -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              onSubmit={submit}
              className="space-y-4"
            >
              {mode === 'register' ? (
                <>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-exchange-muted">
                      Kullanıcı Adı
                    </label>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      enterKeyHint="next"
                      placeholder="örn. deniz_trader"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-exchange-muted">
                      E-posta
                    </label>
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      enterKeyHint="next"
                      placeholder="ornek@eposta.com"
                      className={inputClass}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-exchange-muted">
                    Kullanıcı Adı veya E-posta
                  </label>
                  <input
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    placeholder="kullanıcı adı veya e-posta"
                    className={inputClass}
                  />
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-medium text-exchange-muted">
                  Şifre
                </label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="••••••••"
                  className={inputClass}
                />
              </div>

              {mode === 'register' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-exchange-muted">
                    Şifre (Tekrar)
                  </label>
                  <input
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    className={inputClass}
                  />
                </div>
              )}

              {mode === 'register' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-exchange-muted">
                    Referans Kodu (Opsiyonel)
                  </label>
                  <input
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value)}
                    autoComplete="off"
                    placeholder="örn. testref2026"
                    className={inputClass}
                  />
                </div>
              )}

              {mode === 'register' && (
                <div className="rounded-lg border border-exchange-buy/30 bg-exchange-buy/5 px-3 py-2 text-[11px] leading-relaxed text-exchange-buy">
                  🎁 Referans kodu opsiyoneldir — boş bırakılırsa kayıt normal
                  şekilde tamamlanır. Geçersiz bir kod kaydı durdurur.
                </div>
              )}

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-lg border border-exchange-sell/40 bg-exchange-sell/10 px-3 py-2 text-xs font-medium text-exchange-sell">
                      {error}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <Button type="submit" size="lg" className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-black border-t-transparent" />
                    İşleniyor…
                  </>
                ) : mode === 'login' ? (
                  'Giriş Yap'
                ) : (
                  'Kayıt Ol ve Başla'
                )}
              </Button>
            </motion.form>
          </AnimatePresence>
        </div>

        <p className="mt-6 text-center text-xs text-exchange-muted">
          © {new Date().getFullYear()} DenizTradeX
        </p>
      </motion.div>
    </div>
  )
}