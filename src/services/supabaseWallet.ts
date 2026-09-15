import { supabase } from '@/lib/supabase'

export interface Profile {
  id: string
  username: string
  email: string
  full_name: string | null
  avatar_url: string | null
  balance: number
  /** Yönetici tarafından dondurulan hesaplar giriş yapamaz. */
  is_frozen: boolean
  /** Hesabın kullandığı promosyon kodları (küçük harf). Cihazlar arası
   *  tek-kullanım kuralının kaynağı. */
  used_promos: string[]
  created_at: string
}

export type DepositSource = 'card' | 'promo' | 'referral'

/**
 * Default balance for a freshly created profile. Mirrors the
 * `balance numeric(20,4) not null default 10000.00` column default and the
 * value seeded by the `handle_new_user` trigger, so an in-memory fallback
 * profile behaves exactly like a DB-seeded one.
 */
export const DEFAULT_PROFILE_BALANCE = 10000

/**
 * Minimal shape of `auth.users` data needed to build a safe fallback profile.
 * Supabase `auth.signInWithPassword` / `signUp` always returns this, even when
 * the `profiles` row (created by the `handle_new_user` trigger) is not
 * visible yet due to trigger lag, replication delay, or an RLS hiccup.
 */
export interface AuthUserLike {
  id: string
  email?: string | null
  username?: string | null
  created_at?: string | null
}

interface DbProfile {
  id: string
  username: string
  email: string
  full_name: string | null
  avatar_url: string | null
  balance: number | string | null
  is_frozen: unknown
  used_promos: unknown
  created_at: string
}

function toBalance(value: number | string | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const n = parseFloat(value)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  return null
}

function parseProfile(row: DbProfile): Profile | null {
  const balance = toBalance(row.balance)
  if (balance === null) return null
  const used_promos = Array.isArray(row.used_promos)
    ? row.used_promos
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean)
    : []
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    full_name: row.full_name,
    avatar_url: row.avatar_url,
    balance,
    // Eski DB'lerde kolon henüz yoksa `undefined` gelir — eksik kolon
    // "dondurulmuş" sayılmaz, hesap açık kabul edilir.
    is_frozen: row.is_frozen === true,
    used_promos,
    created_at: row.created_at,
  }
}

export async function getProfile(userId: string): Promise<Profile | null> {
  if (!supabase || !userId) return null
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    if (error || !data) return null
    return parseProfile(data as DbProfile)
  } catch {
    return null
  }
}

export async function getProfileBalance(userId: string): Promise<number | null> {
  const profile = await getProfile(userId)
  return profile?.balance ?? null
}

const PROFILE_RETRY_DELAY_MS = 400

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Like `getProfileBalance`, but with short backoff: the `profiles` row is
 * seeded by the `handle_new_user` DB trigger right after sign-up, so right
 * after `signInWithPassword` / `signUp` the row may briefly not be visible
 * yet (async trigger / replication lag). Instead of crashing or applying a
 * stale balance, re-query every `delayMs` up to `attempts` times and return
 * the balance as soon as the profile shows up.
 *
 * When there is no Supabase backend (offline / tests) there is nothing to
 * wait on — returns immediately.
 */
export async function getProfileBalanceWithRetry(
  userId: string,
  attempts = 5,
  delayMs = PROFILE_RETRY_DELAY_MS,
): Promise<number | null> {
  const profile = await getProfileWithRetry(userId, attempts, delayMs)
  return profile?.balance ?? null
}

/**
 * Retry wrapper around `getProfile`: polls the `profiles` table until the
 * `handle_new_user` trigger row becomes visible (or attempts run out).
 * Never throws — returns `null` when the row never appears, so callers can
 * fall back to `auth.users` data instead of locking the app or signing out.
 */
export async function getProfileWithRetry(
  userId: string,
  attempts = 5,
  delayMs = PROFILE_RETRY_DELAY_MS,
): Promise<Profile | null> {
  if (!supabase || !userId) return null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const profile = await getProfile(userId)
    if (profile) return profile
    if (attempt < attempts) await wait(delayMs)
  }
  return null
}

/**
 * Build an in-memory default profile purely from `auth.users` data.
 * Used when the `profiles` row is momentarily missing at login: the app
 * stays usable with sensible defaults (username from metadata or the email
 * prefix, default balance) instead of locking or clearing the session.
 * Never throws for a valid `authUser.id`; sanitizes blank usernames/emails.
 */
export function buildFallbackProfile(authUser: AuthUserLike): Profile {
  const email = (authUser.email ?? '').trim()
  const rawUsername = (authUser.username ?? '').trim()
  const username =
    rawUsername || (email.includes('@') ? email.split('@')[0] : '') || 'user'
  return {
    id: authUser.id,
    username,
    email,
    full_name: null,
    avatar_url: null,
    balance: DEFAULT_PROFILE_BALANCE,
    is_frozen: false,
    used_promos: [],
    created_at: authUser.created_at ?? new Date().toISOString(),
  }
}

/**
 * Safe profile loader for the login flow: retries briefly for the trigger
 * row, then falls back to an in-memory profile built from `auth.users`.
 * Never returns `null` for a valid `authUser.id` and never throws — the
 * login flow must not lock the UI or sign the user out just because the
 * profile row lagged behind.
 */
export async function getProfileWithFallback(
  authUser: AuthUserLike,
  attempts = 5,
  delayMs = PROFILE_RETRY_DELAY_MS,
): Promise<Profile> {
  try {
    const profile = await getProfileWithRetry(authUser.id, attempts, delayMs)
    if (profile) return profile
  } catch {
    // Intentionally ignored — fall through to the auth-based default below.
  }
  return buildFallbackProfile(authUser)
}

export async function findProfileByEmail(email: string): Promise<Profile | null> {
  if (!supabase || !email) return null
  const needle = email.trim().toLowerCase()
  if (!needle) return null
  try {
    // `ilike` — e-posta eşleşmesi büyük-küçük harfe duyarsız olmalı
    // (bazı satırlar normalize edilmeden yazılmış olabilir).
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .ilike('email', needle)
      .maybeSingle()
    if (error || !data) return null
    return parseProfile(data as DbProfile)
  } catch {
    return null
  }
}

export async function findProfileByUsername(username: string): Promise<Profile | null> {
  if (!supabase || !username) return null
  const needle = username.trim()
  if (!needle) return null
  try {
    // `ilike` — kullanıcı adı eşleşmesi büyük-küçük harfe duyarsız.
    // iOS Safari ilk harfi otomatik büyütür ("Deniz" vs "deniz");
    // `eq` ile yapılan tam eşleşme bu yüzden "bulunamadı" döndürüyordu.
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .ilike('username', needle)
      .maybeSingle()
    if (error || !data) return null
    return parseProfile(data as DbProfile)
  } catch {
    return null
  }
}

/**
 * Giriş öncesi kullanıcı adı/e-posta -> e-posta çözümlemesi.
 *
 * Neden RPC? `profiles` tablosundaki RLS politikası (`profiles_select_own`)
 * anonim kullanıcıların tabloyu okumasını engeller — ama login ekranı
 * girişten ÖNCE kullanıcı adından e-postayı bulmak zorundadır (özellikle
 * çıkış yapılmışken, yani anon iken). `resolve_login_email` SECURITY
 * DEFINER bir fonksiyondur: yalnızca eşleşen e-postayı döndürür, başka
 * kolon sızdırmaz. RLS'nin reddettiği durumlarda (Safari'de çıkış sonrası
 * "Kullanıcı bulunamadı" hatasının kök nedeni) bu yol çalışmaya devam eder.
 *
 * Sıra: RPC -> doğrudan sorgu. Hiçbiri cevap vermezse `null`.
 */
export async function resolveLoginEmail(login: string): Promise<string | null> {
  const needle = login.trim()
  if (!supabase || !needle) return null
  try {
    const { data, error } = await supabase.rpc('resolve_login_email', {
      p_login: needle,
    })
    if (!error && typeof data === 'string' && data.trim()) {
      return data.trim()
    }
  } catch {
    // RPC yoksa (eski DB) veya ağ hatası — doğrudan sorguya düş.
  }
  try {
    if (needle.includes('@')) {
      const byEmail = await findProfileByEmail(needle)
      if (byEmail?.email) return byEmail.email
    } else {
      const byUsername = await findProfileByUsername(needle)
      if (byUsername?.email) return byUsername.email
    }
  } catch {
    return null
  }
  return null
}

/**
 * Kayıt/giriş sonrası garanti satırı: `handle_new_user` trigger'ı
 * gecikebilir veya çakışma yüzünden satır oluşturamayabilir. Bu upsert,
 * girişi yapan kullanıcının kendi satırını (RLS: authenticated + own)
 * oluşturur/günceller; böylece sonraki kullanıcı-adı aramaları ve bakiye
 * senkronu asla boş satıra takılmaz. Başarısızlık sessizce yoksayılır
 * (in-memory fallback zaten devrede).
 */
export async function ensureProfileRow(input: {
  id: string
  username: string
  email: string
}): Promise<void> {
  if (!supabase || !input.id) return
  const username = input.username.trim() || `user_${input.id.slice(0, 8)}`
  const email = input.email.trim().toLowerCase()
  try {
    await supabase.from('profiles').upsert(
      { id: input.id, username, email },
      { onConflict: 'id' },
    )
  } catch {
    // best effort — login akışı asla bu yüzden durmaz
  }
}

export async function setProfileBalance(
  userId: string,
  balance: number,
): Promise<boolean> {
  if (!supabase || !userId || !Number.isFinite(balance) || balance < 0) return false
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ balance })
      .eq('id', userId)
    return !error
  } catch {
    return false
  }
}

export interface DepositInput {
  userId: string
  amountUsdt: number
  amountTry?: number | null
  rate?: number | null
  method?: string
  source?: DepositSource
  referralCode?: string | null
}

export async function recordDeposit(input: DepositInput): Promise<void> {
  if (!supabase || !input.userId) return
  if (!Number.isFinite(input.amountUsdt) || input.amountUsdt <= 0) return
  try {
    await supabase.from('deposit_history').insert({
      user_id: input.userId,
      amount_usdt: input.amountUsdt,
      amount_try: input.amountTry ?? null,
      rate: input.rate ?? null,
      method: input.method ?? 'card',
      source: input.source ?? 'card',
      meta: input.referralCode ? { referral_code: input.referralCode } : {},
    })
  } catch {
    // best effort — never throw into the UI
  }
}

export interface TransactionInput {
  userId: string
  type: 'trade_buy' | 'trade_sell' | 'withdraw' | 'promo' | 'referral'
  symbol?: string
  side?: 'buy' | 'sell'
  quantity?: number
  price?: number
  amountUsdt?: number
  balanceAfter?: number
}

export async function recordTransaction(input: TransactionInput): Promise<void> {
  if (!supabase || !input.userId) return
  try {
    await supabase.from('transactions').insert({
      user_id: input.userId,
      type: input.type,
      symbol: input.symbol ?? null,
      side: input.side ?? null,
      quantity: input.quantity ?? null,
      price: input.price ?? null,
      amount_usdt: input.amountUsdt ?? null,
      balance_after: input.balanceAfter ?? null,
    })
  } catch {
    // best effort — never throw into the UI
  }
}

/**
 * Records a funded deposit (card/promo/referral) AND keeps the profile
 * balance in sync so the Supabase records match the on-screen wallet.
 */
export async function syncDepositToSupabase(input: {
  userId: string
  amountUsdt: number
  amountTry?: number | null
  rate?: number | null
  method?: string
  source?: DepositSource
  referralCode?: string | null
}): Promise<void> {
  if (!supabase || !input.userId) return
  if (!Number.isFinite(input.amountUsdt) || input.amountUsdt <= 0) return
  await recordDeposit(input)
  const current = await getProfileBalance(input.userId)
  if (current !== null) {
    await setProfileBalance(input.userId, current + input.amountUsdt)
  }
}

/** Withdrawal: ledger row + profile balance sync. */
export async function syncWithdrawToSupabase(input: {
  userId: string
  amountUsdt: number
}): Promise<void> {
  if (!supabase || !input.userId) return
  if (!Number.isFinite(input.amountUsdt) || input.amountUsdt <= 0) return
  const current = await getProfileBalance(input.userId)
  const after = current === null ? null : Math.max(0, current - input.amountUsdt)
  await recordTransaction({
    userId: input.userId,
    type: 'withdraw',
    amountUsdt: input.amountUsdt,
    balanceAfter: after ?? undefined,
  })
  if (after !== null) await setProfileBalance(input.userId, after)
}

export type PromoClaimResult = 'claimed' | 'already' | 'offline' | 'error'

/**
 * Hesap bazında tek-kullanımlık promosyon hakkı: `claim_promo` RPC'si
 * profil satırını kilitleyerek işaretler. İki cihaz aynı anda istese
 * bile biri `claimed`, diğeri `already` alır — çift bakiye geçmez.
 *
 * - `'offline'`: Supabase yok (test/offline) veya RPC henüz DB'de yok
 *   (migration uygulanmamış) — arayan yerel mantığa düşer.
 * - `'error'`: ağ/RLS hatası — arayan bakiye işlemesin (fail-closed).
 */
export async function claimPromoRemote(
  userId: string,
  code: string,
): Promise<PromoClaimResult> {
  if (!supabase || !userId) return 'offline'
  const normalized = code.trim().toLowerCase()
  if (!normalized) return 'error'
  try {
    const { data, error } = await supabase.rpc('claim_promo', {
      p_code: normalized,
    })
    if (error) {
      // Migration uygulanmamış eski DB: fonksiyon yok (PGRST202) —
      // yerel tek-cihaz mantığına düş, uygulamayı kilitleme.
      if ((error as { code?: string }).code === 'PGRST202') return 'offline'
      return 'error'
    }
    return data === true ? 'claimed' : 'already'
  } catch {
    return 'error'
  }
}

/**
 * Hesabın o ana dek kullandığı promosyon kodları (diğer cihazlar dahil).
 * Kendi satırı (`profiles_select_own`) üzerinden okunur; giriş sonrası
 * yerel listeyle birleştirilip çift kullanım engellenir.
 */
export async function fetchUsedPromos(userId: string): Promise<string[]> {
  if (!supabase || !userId) return []
  try {
    const profile = await getProfile(userId)
    return profile?.used_promos ?? []
  } catch {
    return []
  }
}