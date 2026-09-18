import { supabase } from '@/lib/supabase'

export interface Profile {
  id: string
  username: string
  email: string
  full_name: string | null
  avatar_url: string | null
  /** Forumda isim altında görünen özel etiket (max 24 karakter). */
  user_tag: string | null
  balance: number
  /** Yönetici tarafından dondurulan hesaplar giriş yapamaz. */
  is_frozen: boolean
  /** Kalıcı yasaklı hesaplar giriş yapamaz. */
  is_banned: boolean
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
  user_tag: unknown
  balance: number | string | null
  is_frozen: unknown
  is_banned: unknown
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
    user_tag: typeof row.user_tag === 'string' && row.user_tag.trim() ? row.user_tag.trim().slice(0, 24) : null,
    balance,
    // Eski DB'lerde kolon henüz yoksa `undefined` gelir — eksik kolon
    // "dondurulmuş"/"yasaklı" sayılmaz, hesap açık kabul edilir.
    is_frozen: row.is_frozen === true,
    is_banned: row.is_banned === true,
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
    user_tag: null,
    balance: DEFAULT_PROFILE_BALANCE,
    is_frozen: false,
    is_banned: false,
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

/**
 * İşlem sonrası bakiye itme: trade kapanışları/açılışları yalnızca yerel
 * bakiyeyi değiştirirdi; sunucu geride kalır, girişteki senkron da oturum
 * kârını silerdi. Kapanıştan hemen sonra yerel tutar aynen yazılır —
 * sunucu her zaman güncel kalır, giriş senkronu ve admin paneli doğru
 * görür. Sessizdir (best-effort), asla fırlatmaz.
 */
export async function pushBalanceToServer(userId: string, balance: number): Promise<void> {
  if (!supabase || !userId || !Number.isFinite(balance) || balance < 0) return
  try {
    await supabase.from('profiles').update({ balance }).eq('id', userId)
  } catch {
    // best effort — yerel bakiye zaten güncel, sunucu sonra yakalar
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
  const source = input.source ?? 'card'
  // Backstop SADECE kart yüklemelerinde devreye girer: kısıtlı hesabın
  // kart defteri kirlenmez (birincil kapı arayüzdeki işlem-öncesi
  // kontroldür; burası sessizce atlar). Promosyon/referral bonusları
  // kısıtlı hesaba da işlenir — sunucu bakiyesi ekranla senkron kalır,
  // profil senkronu bonusu geri almaz.
  if (source === 'card') {
    try {
      assertDepositAllowed(await getMoneyRestrictions(input.userId))
    } catch {
      return
    }
  }
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
  // Backstop: kısıtlı hesabın sunucu defteri kirlenmez (birincil kapı
  // arayüzdeki işlem-öncesi kontrolüdür; burası sessizce atlar).
  try {
    assertWithdrawAllowed(await getMoneyRestrictions(input.userId))
  } catch {
    return
  }
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

// ---------------------------------------------------------------
// Profil fotoğrafı (avatar): `storage.avatars` kovası, herkese-açık
// okuma. Dosya `<userId>/avatar_<zaman>.<uzantı>` yoluna yazılır;
// her yüklemede eski dosyalar temizlenir (artık dosya birikmez).
// Profil satırındaki `avatar_url`, forum yazılarına tetikleyiciyle
// kopyalanır — ayrıca okuma gerekmez.
// ---------------------------------------------------------------

export const AVATAR_MAX_BYTES = 10 * 1024 * 1024

const AVATAR_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function validateAvatarFile(file: File): string {
  const mime = (file.type || '').toLowerCase()
  const ext = AVATAR_EXT_BY_MIME[mime]
  if (!ext) {
    throw new Error('Yalnızca JPG, PNG, WEBP veya GIF fotoğrafı yükleyebilirsin.')
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Dosya okunamadı. Başka bir fotoğraf dene.')
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new Error('Fotoğraf en fazla 10MB olabilir.')
  }
  return ext
}

export async function uploadAvatarFile(userId: string, file: File): Promise<string> {
  const ext = validateAvatarFile(file)
  if (!supabase || !userId) {
    throw new Error('Fotoğraf yüklemek için giriş yapmalısın.')
  }
  const path = `${userId}/avatar_${Date.now()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) throw new Error('Fotoğraf yüklenemedi. Lütfen tekrar dene.')

  // Eski avatar dosyalarını temizle (en iyisi: kalan artıklar zararsız).
  try {
    const { data: listed } = await supabase.storage.from('avatars').list(userId)
    const stale = (listed ?? []).map((f) => f.name).filter((n) => n && `${userId}/${n}` !== path)
    if (stale.length > 0) {
      await supabase.storage.from('avatars').remove(stale.map((n) => `${userId}/${n}`))
    }
  } catch {
    // best effort
  }

  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const publicUrl = data?.publicUrl ?? ''
  if (!publicUrl) throw new Error('Fotoğraf adresi alınamadı. Lütfen tekrar dene.')

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ avatar_url: publicUrl })
    .eq('id', userId)
  if (profileError) throw new Error('Fotoğraf profile işlenemedi. Lütfen tekrar dene.')
  return publicUrl
}

export async function removeAvatarFile(userId: string): Promise<void> {  if (!supabase || !userId) {
    throw new Error('Fotoğraf silmek için giriş yapmalısın.')
  }
  try {
    const { data: listed } = await supabase.storage.from('avatars').list(userId)
    const names = (listed ?? []).map((f) => f.name).filter(Boolean)
    if (names.length > 0) {
      await supabase.storage.from('avatars').remove(names.map((n) => `${userId}/${n}`))
    }
  } catch {
    // best effort — profil satırı yine temizlenir
  }
  const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', userId)
  if (error) throw new Error('Fotoğraf silinemedi. Lütfen tekrar dene.')
}

// ---------------------------------------------------------------
// Kullanıcı adı + forum etiketi (Ayarlar → Kullanıcı Adı Değiştir).
// `user_tag` kolonu yoksa (eski DB) etiket sessizce atlanır — isim
// değişikliği yine işler. Migration: 20260918*_profile_tag.
// ---------------------------------------------------------------

export const USER_TAG_MAX = 24

export function validateUserTag(raw: string): string | null {
  const t = raw.trim().slice(0, USER_TAG_MAX)
  if (!t) return null
  if (/[<>@]/.test(t)) throw new Error('Etikette < > @ karakterleri kullanılamaz.')
  return t
}

export async function updateProfileUsernameAndTag(
  userId: string,
  username: string,
  tag: string | null,
): Promise<void> {
  if (!supabase || !userId) {
    throw new Error('Oturum bulunamadı. Tekrar giriş yap.')
  }
  const payload: Record<string, unknown> = { username }
  if (tag !== undefined) payload.user_tag = tag
  const { error } = await supabase.from('profiles').update(payload).eq('id', userId)
  if (error) {
    const msg = String((error as { message?: unknown }).message ?? '')
    if (msg.includes('duplicate') || msg.includes('unique') || (error as { code?: string }).code === '23505') {
      throw new Error('Bu kullanıcı adı zaten kullanılıyor.')
    }
    // `user_tag` kolonu yoksa ismi yine kurtar (eski DB uyumluluğu).
    if (tag !== null && /user_tag|column|schema cache|PGRST/i.test(msg)) {
      const retry = await supabase.from('profiles').update({ username }).eq('id', userId)
      if (retry.error) throw new Error('Kullanıcı adı güncellenemedi. Lütfen tekrar dene.')
      return
    }
    throw new Error('Kullanıcı adı güncellenemedi. Lütfen tekrar dene.')
  }
}

// ---------------------------------------------------------------
// Forum fotoğrafı: `storage.forum-images` kovası, herkese-açık okuma.
// Dosya `<userId>/forum_<zaman>.<uzantı>` yoluna yazılır; en fazla
// 10MB (istemci kapısı — mobil kotayı korur). Supabase yoksa (yerel
// mod) veri-URL'si döndürülür (oturum içi önizleme/kayıt).
// ---------------------------------------------------------------

export const FORUM_IMAGE_MAX_BYTES = 10 * 1024 * 1024

const FORUM_IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function validateForumImageFile(file: File): string {
  const mime = (file.type || '').toLowerCase()
  const ext = FORUM_IMAGE_EXT_BY_MIME[mime]
  if (!ext) {
    throw new Error('Yalnızca JPG, PNG, WEBP veya GIF fotoğrafı ekleyebilirsin.')
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Dosya okunamadı. Başka bir fotoğraf dene.')
  }
  if (file.size > FORUM_IMAGE_MAX_BYTES) {
    throw new Error('Fotoğraf en fazla 10MB olabilir.')
  }
  return ext
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Dosya okunamadı. Başka bir fotoğraf dene.'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Dosya okunamadı. Başka bir fotoğraf dene.'))
    }
    reader.readAsDataURL(file)
  })
}

export async function uploadForumImageFile(userId: string, file: File): Promise<string> {
  const ext = validateForumImageFile(file)
  if (!supabase || !userId) {
    // Yerel mod: veri-URL (oturum içi; kota aşımında kayıt yine denenir,
    // yazılamazsa akış metinle devam eder).
    return readFileAsDataUrl(file)
  }
  const path = `${userId}/forum_${Date.now()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from('forum-images')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) throw new Error('Fotoğraf yüklenemedi. Lütfen tekrar dene.')
  const { data } = supabase.storage.from('forum-images').getPublicUrl(path)
  const publicUrl = data?.publicUrl ?? ''
  if (!publicUrl) throw new Error('Fotoğraf adresi alınamadı. Lütfen tekrar dene.')
  return publicUrl
}

// ---------------------------------------------------------------
// Para yatırma / çekme kısıtlaması: admin `profiles.deposit_blocked` /
// `withdraw_blocked` bayrağını açarsa kullanıcı o yönde işlem yapamaz.
// Okuma hatası/çevrimdışı = kısıtsız (fail-open): engel yalnızca
// bilinen kısıtlarda devreye girer, ağ sorunu işlemi kilitlemez.
// ---------------------------------------------------------------

export interface MoneyRestrictions {
  depositBlocked: boolean
  withdrawBlocked: boolean
}

export const NO_MONEY_RESTRICTIONS: MoneyRestrictions = {
  depositBlocked: false,
  withdrawBlocked: false,
}

export async function getMoneyRestrictions(userId: string): Promise<MoneyRestrictions> {
  if (!supabase || !userId) return { ...NO_MONEY_RESTRICTIONS }
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('deposit_blocked,withdraw_blocked')
      .eq('id', userId)
      .maybeSingle()
    if (error || !data) return { ...NO_MONEY_RESTRICTIONS }
    const row = data as { deposit_blocked?: unknown; withdraw_blocked?: unknown }
    return {
      depositBlocked: row.deposit_blocked === true,
      withdrawBlocked: row.withdraw_blocked === true,
    }
  } catch {
    return { ...NO_MONEY_RESTRICTIONS }
  }
}

export function assertDepositAllowed(r: MoneyRestrictions): void {
  if (r.depositBlocked) {
    throw new Error('Para yatırma işlemin yönetici tarafından kısıtlanmış. Destek ile iletişime geç.')
  }
}

export function assertWithdrawAllowed(r: MoneyRestrictions): void {
  if (r.withdrawBlocked) {
    throw new Error('Para çekme işlemin yönetici tarafından kısıtlanmış. Destek ile iletişime geç.')
  }
}