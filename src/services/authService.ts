import type { User } from '@/types'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  ensureProfileRow,
  findProfileByEmail,
  findProfileByUsername,
  getProfileWithFallback,
  resolveLoginEmail,
} from '@/services/supabaseWallet'

/**
 * Auth backend — Supabase Auth first, localStorage fallback.
 *
 * When the Supabase client is configured (real dev/prod builds) `register`,
 * `login` and `logout` talk to `supabase.auth`. When it isn't (vitest runs)
 * the app keeps working against the lightweight localStorage backend so the
 * full test suite stays deterministic and offline.
 *
 * The active session is always mirrored to `deniztradx_session`, which the
 * rest of the app (cards, wallet, settings) already keys off.
 */

const USERS_KEY = 'deniztradx_users'
const SESSION_KEY = 'deniztradx_session'

/**
 * Aynı cihazda kayıt -> çıkış -> giriş döngüsünü DB'den bağımsız
 * kurtaran yerel kullanıcı-adı -> e-posta haritası. Safari'de çıkış
 * sonrası `profiles` okuması RLS/ağ nedeniyle başarısız olsa bile
 * kullanıcı kendi cihazında girişe devam edebilir.
 */
const USERNAME_MAP_KEY = 'deniztradx_username_map'

/** Safari gizli modunda localStorage yazımı patlayabilir — sessiz geç. */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // kota/gizli mod — oturum yalnızca bellekte yaşar
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // yoksay
  }
}

function readUsernameMap(): Record<string, string> {
  try {
    const raw = safeGet(USERNAME_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function rememberUsername(username: string, email: string): void {
  const key = username.trim().toLowerCase()
  const value = email.trim().toLowerCase()
  if (!key || !value) return
  try {
    const map = readUsernameMap()
    map[key] = value
    safeSet(USERNAME_MAP_KEY, JSON.stringify(map))
  } catch {
    // best effort
  }
}

function lookupRememberedEmail(username: string): string | null {
  const email = readUsernameMap()[username.trim().toLowerCase()]
  return typeof email === 'string' && email.includes('@') ? email : null
}

/**
 * Referral codes that are accepted at registration. Empty field is fine;
 * anything entered must match one of these (case-insensitive).
 * Startup seed list — expand later.
 */
export const VALID_REFERRAL_CODES = ['testref2026']

interface StoredUser extends User {
  readonly passwordHash: string
}

function readUsers(): StoredUser[] {
  try {
    const raw = safeGet(USERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredUser[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeUsers(users: StoredUser[]) {
  safeSet(USERS_KEY, JSON.stringify(users))
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export async function hashPassword(password: string): Promise<string> {
  const text = `deniztradx::${password}::pepper`
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  // Fallback for environments without WebCrypto (e.g. jsdom). Not for production use.
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return `fb_${(h >>> 0).toString(16)}`
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
}

export function toPublicUser(u: StoredUser): User {
  return { id: u.id, username: u.username, email: u.email, createdAt: u.createdAt }
}

export function getSessionUser(): User | null {
  try {
    const raw = safeGet(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as User
    if (!parsed || typeof parsed.id !== 'string' || !parsed.username) return null
    return parsed
  } catch {
    return null
  }
}

export function getSessionUserId(): string | null {
  return getSessionUser()?.id ?? null
}

function setSession(user: User) {
  safeSet(SESSION_KEY, JSON.stringify(user))
}

function toCreatedAt(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? t : Date.now()
}

/** Maps Supabase auth errors to friendly Turkish messages. */
function toTurkishAuthError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('already registered') || lower.includes('user already registered')) {
    return 'Bu e-posta adresi zaten kayıtlı.'
  }
  if (
    lower.includes('invalid login credentials') ||
    lower.includes('invalid_credentials') ||
    // Supabase'in yeni hata metinleri:
    lower.includes('email not confirmed')
  ) {
    if (lower.includes('email not confirmed')) {
      return 'E-posta adresiniz henüz onaylanmamış. Lütfen e-postanızı kontrol edin.'
    }
    return 'Kullanıcı adı veya şifre hatalı.'
  }
  if (lower.includes('user not found')) {
    return 'Kullanıcı bulunamadı.'
  }
  if (lower.includes('password should be at least 6')) {
    return 'Şifreniz en az 6 karakter olmalı.'
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('failed to fetch')) {
    return 'Bağlantı kurulamadı. İnternetinizi kontrol edip tekrar deneyin.'
  }
  return message
}

export async function register(input: {
  username: string
  email: string
  password: string
  referralCode?: string
}): Promise<User> {
  const username = input.username.trim()
  const email = input.email.trim().toLowerCase()

  if (username.length < 3) {
    throw new Error('Kullanıcı adı en az 3 karakter olmalı.')
  }
  if (!isValidEmail(email)) {
    throw new Error('Geçerli bir e-posta adresi girin.')
  }
  if (input.password.length < 6) {
    throw new Error('Şifreniz en az 6 karakter olmalı.')
  }

  // Referral code is optional — an empty field registers normally. When one
  // is provided it must exist in the valid codes list, otherwise registration
  // is rejected.
  const referral = input.referralCode?.trim().toLowerCase() ?? ''
  if (referral && !VALID_REFERRAL_CODES.includes(referral)) {
    throw new Error('Geçersiz referans kodu.')
  }

  if (isSupabaseConfigured && supabase) {
    const emailTaken = await findProfileByEmail(email)
    if (emailTaken) {
      throw new Error('Bu e-posta adresi zaten kayıtlı.')
    }
    const usernameTaken = await findProfileByUsername(username)
    if (usernameTaken) {
      throw new Error('Bu kullanıcı adı zaten kullanılıyor.')
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password: input.password,
      options: { data: { username } },
    })
    if (error) {
      throw new Error(toTurkishAuthError(error.message))
    }
    if (!data.user) {
      throw new Error('Kayıt tamamlanamadı. Lütfen tekrar deneyin.')
    }

    const user: User = {
      id: data.user.id,
      username,
      email: data.user.email ?? email,
      createdAt: toCreatedAt(data.user.created_at),
    }
    // Trigger gecikebilir/çakışabilir — profil satırını garanti altına al
    // ki sonraki girişlerde kullanıcı-adı çözümlemesi boş dönmesin.
    await ensureProfileRow({ id: user.id, username, email: user.email })
    // Aynı cihazda çıkış sonrası giriş için yerel haritayı güncelle.
    rememberUsername(username, user.email)
    // The rest of the app keys off this local session (cards, wallet, settings).
    setSession(user)
    return user
  }

  const users = readUsers()
  const takenUsername = users.some((u) => u.username.toLowerCase() === username.toLowerCase())
  if (takenUsername) {
    throw new Error('Bu kullanıcı adı zaten kullanılıyor.')
  }
  const takenEmail = users.some((u) => u.email === email)
  if (takenEmail) {
    throw new Error('Bu e-posta adresi zaten kayıtlı.')
  }

  const user: StoredUser = {
    id: makeId('usr'),
    username,
    email,
    passwordHash: await hashPassword(input.password),
    createdAt: Date.now(),
  }
  writeUsers([...users, user])

  const publicUser = toPublicUser(user)
  rememberUsername(username, email)
  setSession(publicUser)
  return publicUser
}

export async function login(identifier: string, password: string): Promise<User> {
  const key = identifier.trim().toLowerCase()
  if (!key || !password) {
    throw new Error('Kullanıcı adı ve şifre gerekli.')
  }

  if (isSupabaseConfigured && supabase) {
    let email = key
    if (!key.includes('@')) {
      // Kullanıcı adı -> e-posta çözümlemesi (girişten ÖNCE, yani anonim).
      // Sıra: 1) bu cihazda hatırlanan harita (Safari çıkış-sonrası
      // RLS/ağ sorunlarına karşı), 2) RLS'yi baypas eden RPC, 3) doğrudan
      // tablo sorgusu. Üçü de boş dönerse kullanıcı gerçekten yoktur.
      email =
        lookupRememberedEmail(key) ??
        (await resolveLoginEmail(key)) ??
        (await findProfileByUsername(key))?.email ??
        ''
      // RPC/bellek farklı yazımı bulmuş olabilir (örn. iOS oto-büyük harf);
      // tablo sorgusu büyük-küçük harfe duyarsız (ilike) olduğu için
      // buradaki fallback zinciri yazım farklarını tolere eder.
      if (!email) {
        throw new Error('Kullanıcı bulunamadı.')
      }
    }

    const { data, error } = await (async () => {
      // Devam eden bir çıkış varsa önce onun bitmesini bekle — kuyruktaki
      // signOut temizliği yeni girişin tokenlarını silmesin (Safari fix).
      await waitForPendingSignOut()
      return supabase.auth.signInWithPassword({
        email,
        password,
      })
    })()
    if (error || !data.user) {
      // Kullanıcı adı doğru ama şifre yanlışsa Supabase "invalid login
      // credentials" döner — bunu "şifre hatalı" diye netleştir ki
      // kullanıcı "bulunamadı" sanıp boşuna kayıt olmaya çalışmasın.
      const msg = toTurkishAuthError(error?.message ?? 'Hatalı şifre.')
      throw new Error(msg)
    }

    const authUser = data.user
    // Safe fallback: the `profiles` row (seeded by `handle_new_user`) can lag
    // briefly behind auth. `getProfileWithFallback` retries for a moment and
    // then builds an in-memory default profile from `auth.users` data, so a
    // missing row never locks the app and never signs the user back out —
    // the verified session is always kept.
    const profile = await getProfileWithFallback({
      id: authUser.id,
      email: authUser.email ?? email,
      username: authUser.user_metadata?.username as string | undefined,
      created_at: authUser.created_at,
    })
    // Yönetici tarafından dondurulan hesaplar giriş yapamaz: az önce
    // açılan Supabase oturumu kapatılıp yerel oturum yazılmadan hata
    // fırlatılır.
    if (profile.is_frozen === true) {
      await logout()
      throw new Error('Hesabın yönetici tarafından dondurulmuş. Destek ile iletişime geç.')
    }
    const user: User = {
      id: authUser.id,
      username: profile.username || email.split('@')[0],
      email: profile.email || authUser.email || email,
      createdAt: toCreatedAt(profile.created_at ?? authUser.created_at),
    }
    // Eksik/gecikmiş profil satırını kalıcı olarak onar ve bu cihazın
    // haritasını tazele — bir sonraki çıkış->giriş döngüsü DB'ye
    // bağımlı kalmadan çalışsın.
    await ensureProfileRow({ id: user.id, username: user.username, email: user.email })
    rememberUsername(user.username, user.email)
    setSession(user)
    return user
  }

  const users = readUsers()
  const found = users.find(
    (u) => u.username.toLowerCase() === key || u.email === key,
  )
  if (!found) {
    throw new Error('Kullanıcı bulunamadı.')
  }
  const hash = await hashPassword(password)
  if (hash !== found.passwordHash) {
    throw new Error('Hatalı şifre.')
  }

  const publicUser = toPublicUser(found)
  setSession(publicUser)
  return publicUser
}

/**
 * Devam eden çıkış yarışı koruması: `supabase.auth.signOut()` önce ağa
 * çıkar (`/logout`), depolamadaki tokenları EN SON siler. Kullanıcı çıkışa
 * basıp hemen yeniden giriş yaparsa, kuyruktaki signOut'un sonundaki
 * `_removeSession` YENİ tokenları silebilir (Safari mobilde görülen
 * "oturum düştü / kullanıcı bulunamadı" yarış durumu). Login, girişten
 * önce bu sözü bekleyerek sıralamayı garanti altına alır.
 */
let pendingSignOut: Promise<void> | null = null

function waitForPendingSignOut(): Promise<void> {
  return pendingSignOut ?? Promise.resolve()
}

/**
 * Çıkış: yerel oturum SENKRON temizlenir, ardından Supabase signOut
 * beklenir.
 *
 * - `safeRemove` ilk `await`'ten önce çalışır: çağrıldığı anda oturum
 *   bitmiş sayılır; çıkış sonrası hiçbir yazım eski kullanıcının
 *   session-anahtarlı depolarına (cüzdan/kart/ayar) düşmez.
 * - `await signOut` + `pendingSignOut` takibi: hemen ardından gelen bir
 *   giriş, signOut'un kuyruk temizliği bitmeden başlamaz.
 * - Kullanıcı-adı haritası BİLEREK korunur (giriş kolaylığı için;
 *   şifre içermez).
 */
export async function logout(): Promise<void> {
  safeRemove(SESSION_KEY)
  if (isSupabaseConfigured && supabase) {
    const p: Promise<void> = supabase.auth.signOut().then(
      () => undefined,
      () => undefined,
    )
    pendingSignOut = p
    try {
      await p
    } finally {
      if (pendingSignOut === p) pendingSignOut = null
    }
  }
}

/** Keys private to the wallet store — do not import the internals elsewhere. */
export const WALLET_STORAGE_KEY = 'deniztradx_wallet'