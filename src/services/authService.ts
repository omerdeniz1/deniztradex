import type { User } from '@/types'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import {
  findProfileByEmail,
  findProfileByUsername,
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
    const raw = localStorage.getItem(USERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredUser[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeUsers(users: StoredUser[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users))
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
    const raw = localStorage.getItem(SESSION_KEY)
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
  localStorage.setItem(SESSION_KEY, JSON.stringify(user))
}

function toCreatedAt(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(t) ? t : Date.now()
}

/** Maps Supabase auth errors to friendly Turkish messages. */
function toTurkishAuthError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('already registered')) {
    return 'Bu e-posta adresi zaten kayıtlı.'
  }
  if (lower.includes('invalid login credentials') || lower.includes('invalid_credentials')) {
    return 'Kullanıcı adı veya şifre hatalı.'
  }
  if (lower.includes('password should be at least 6')) {
    return 'Şifreniz en az 6 karakter olmalı.'
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
      const profile = await findProfileByUsername(key)
      if (!profile) {
        throw new Error('Kullanıcı bulunamadı.')
      }
      email = profile.email
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error || !data.user) {
      throw new Error(toTurkishAuthError(error?.message ?? 'Hatalı şifre.'))
    }

    const authUser = data.user
    const user: User = {
      id: authUser.id,
      username: (authUser.user_metadata?.username as string | undefined)
        ?? email.split('@')[0],
      email: authUser.email ?? email,
      createdAt: toCreatedAt(authUser.created_at),
    }
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

export function logout(): void {
  if (isSupabaseConfigured && supabase) {
    void supabase.auth.signOut().catch(() => {
      // network/API hiccup — the local session is cleared below regardless
    })
  }
  localStorage.removeItem(SESSION_KEY)
}

/** Keys private to the wallet store — do not import the internals elsewhere. */
export const WALLET_STORAGE_KEY = 'deniztradx_wallet'