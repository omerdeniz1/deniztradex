import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUserId } from '@/services/authService'

/**
 * DNZ borsa tokenı servisi.
 *
 * - Token ekonomisi: toplam arz 200M (sabit), tohum fiyat 0.50 USDT.
 * - Fiyat SİMÜLASYONU istemcidedir: deterministik yürüyüş (adım hash'i),
 *   zaman bazlı — aynı adım dizisi her cihazda aynı fiyatı verir, test
 *   edilebilir, zamanlayıcı gerektirmez. Sunucu yalnızca bakiye/defter
 *   tutar (`dnz_balances` / `dnz_ledger`).
 * - Supabase yoksa (vitest/çevrimdışı) tüm uzak çağrılar güvenli
 *   varsayılanlara düşer; store yerel çalışmaya devam eder.
 */

export const DNZ_SYMBOL = 'DNZ'
export const DNZ_NAME = 'DNZ Token'
/** Toplam arz: 200.000.000 DNZ (sabit, basım yok). */
export const DNZ_TOTAL_SUPPLY = 200_000_000
/** Tohum fiyat (USDT). */
export const DNZ_SEED_PRICE = 0.5
/** Fiyat yürüyüşü başlangıcı (sabit geçmiş tarih). */
export const DNZ_GENESIS_TS = Date.UTC(2025, 0, 1)
/** Yürüyüş adımı: 5 dakikada bir. */
export const DNZ_PRICE_STEP_MS = 5 * 60 * 1000
/** Adım başına azami gürültü (±%1.5). */
export const DNZ_MAX_STEP_PCT = 0.015
/**
 * Ortalama-dönüş katsayısı: adım başına tohum fiyattan görece sapmanın
 * %2'si kadar geri çekme. Saf yürüyüş 100 bin adımda (2025 genesis'ten
 * beri) taban/tavana yapışırdı; bu çekme fiyatı tohum çevresinde
 * dalgalanan canlı bir bantta tutar.
 */
export const DNZ_REVERSION_RATE = 0.02
export const DNZ_MIN_PRICE = 0.01
export const DNZ_MAX_PRICE = 50

/** Adım endeksinden deterministik [0,1) değeri (FNV-1a). */
export function dnzStepHash(step: number): number {
  const s = `dnz-price:${Math.max(0, Math.floor(step))}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

/** Zaman damgasının ait olduğu fiyat adımı (genesis'ten beri). */
export function dnzStepForTs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= DNZ_GENESIS_TS) return 0
  return Math.floor((ts - DNZ_GENESIS_TS) / DNZ_PRICE_STEP_MS)
}

function clampPrice(p: number): number {
  if (!Number.isFinite(p)) return DNZ_SEED_PRICE
  return Math.min(DNZ_MAX_PRICE, Math.max(DNZ_MIN_PRICE, p))
}

/**
 * Fiyatı `fromStep`'ten `toStep`'e deterministik ilerletir.
 * Aynı adım aralığı her zaman aynı fiyatı üretir. Gürültüye ek olarak
 * hafif ortalama-dönüş uygulanır (uzun vadede tohum çevresinde bant).
 */
export function advanceDnzPrice(price: number, fromStep: number, toStep: number): { price: number; step: number } {
  let p = clampPrice(price)
  const from = Math.max(0, Math.floor(fromStep))
  const to = Math.max(from, Math.floor(toStep))
  for (let s = from + 1; s <= to; s++) {
    const noise = (dnzStepHash(s) - 0.5) * 2 * DNZ_MAX_STEP_PCT
    const pull = -DNZ_REVERSION_RATE * (p - DNZ_SEED_PRICE) / DNZ_SEED_PRICE
    p = clampPrice(p * (1 + noise + pull))
  }
  return { price: p, step: to }
}

// ---------------------------------------------------------------
// Uzak senkron (`dnz_balances` / `dnz_ledger`). Tümü best-effort:
// hata/çevrimdışı durumunda sessiz varsayılan döner, arayan (store)
// yerel çalışmaya devam eder.
// ---------------------------------------------------------------

export async function getDnzBalanceRemote(userId: string): Promise<number | null> {
  if (!isSupabaseConfigured || !supabase || !userId) return null
  try {
    const { data, error } = await supabase
      .from('dnz_balances')
      .select('balance')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    const b = (data as { balance?: unknown }).balance
    const n = typeof b === 'string' ? parseFloat(b) : typeof b === 'number' ? b : NaN
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export async function pushDnzBalanceRemote(userId: string, balance: number): Promise<void> {
  if (!isSupabaseConfigured || !supabase || !userId) return
  if (!Number.isFinite(balance) || balance < 0) return
  try {
    await supabase.from('dnz_balances').upsert(
      { user_id: userId, balance, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  } catch {
    // best effort — yerel bakiye zaten güncel
  }
}

export type DnzLedgerType =
  | 'buy'
  | 'sell'
  | 'fee'
  | 'fee_discount'
  | 'transfer_in'
  | 'transfer_out'
  | 'airdrop'

export interface DnzLedgerInput {
  type: DnzLedgerType
  amountDnz: number
  priceUsdt?: number | null
  amountUsdt?: number | null
  balanceAfter?: number | null
  meta?: Record<string, unknown>
}

export async function recordDnzLedgerRemote(userId: string, entry: DnzLedgerInput): Promise<void> {
  if (!isSupabaseConfigured || !supabase || !userId) return
  if (!Number.isFinite(entry.amountDnz) || entry.amountDnz <= 0) return
  try {
    await supabase.from('dnz_ledger').insert({
      user_id: userId,
      type: entry.type,
      amount_dnz: entry.amountDnz,
      price_usdt: entry.priceUsdt ?? null,
      amount_usdt: entry.amountUsdt ?? null,
      balance_after: entry.balanceAfter ?? null,
      meta: entry.meta ?? {},
    })
  } catch {
    // best effort
  }
}

export interface DnzRemoteEntry {
  id: string
  type: DnzLedgerType
  amountDnz: number
  priceUsdt: number | null
  amountUsdt: number | null
  balanceAfter: number | null
  at: number
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

const DNZ_LEDGER_TYPES: DnzLedgerType[] = [
  'buy',
  'sell',
  'fee',
  'fee_discount',
  'transfer_in',
  'transfer_out',
  'airdrop',
]

export async function fetchDnzLedgerRemote(userId: string, limit = 20): Promise<DnzRemoteEntry[] | null> {
  if (!isSupabaseConfigured || !supabase || !userId) return null
  try {
    const { data, error } = await supabase
      .from('dnz_ledger')
      .select('id,type,amount_dnz,price_usdt,amount_usdt,balance_after,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50))
    if (error || !Array.isArray(data)) return null
    return (data as Record<string, unknown>[]).map((r) => {
      const t = typeof r.type === 'string' ? r.type : ''
      return {
        id: `remote_${String(r.id ?? '')}`,
        type: (DNZ_LEDGER_TYPES as string[]).includes(t) ? (t as DnzLedgerType) : 'buy',
        amountDnz: toNum(r.amount_dnz) ?? 0,
        priceUsdt: toNum(r.price_usdt),
        amountUsdt: toNum(r.amount_usdt),
        balanceAfter: toNum(r.balance_after),
        at: Date.parse(String(r.created_at ?? '')) || 0,
      }
    })
  } catch {
    return null
  }
}

/**
 * Hesaplar arası DNZ transferi (uzak): `transfer_dnz` RPC'si satır
 * kilidiyle taşır, iki tarafa defter + `transactions` satırı yazar.
 */
export async function transferDnzRemote(
  toWallet: string,
  amountDnz: number,
): Promise<{ asset: string; amount: number }> {
  if (!isSupabaseConfigured || !supabase) throw new Error('Çevrimdışı modda DNZ transferi yapılamaz.')
  const userId = getSessionUserId()
  if (!userId) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')
  const { data, error } = await supabase.rpc('transfer_dnz', {
    p_receiver_wallet: toWallet.trim().toUpperCase(),
    p_amount: amountDnz,
  })
  if (error) {
    const msg = String((error as { message?: unknown }).message ?? '')
    if (/bulunamadı/i.test(msg)) throw new Error('Alıcı bulunamadı.')
    if (/kendine/i.test(msg)) throw new Error('Kendine transfer yapamazsın.')
    if (/yetersiz/i.test(msg)) throw new Error(msg)
    if (/tutar/i.test(msg)) throw new Error('Geçerli bir tutar gir.')
    if ((error as { code?: string }).code === 'PGRST202') {
      throw new Error(
        "DNZ altyapısı veritabanında yok. Yönetici Supabase SQL Editor'de 20260918170000_dnz_token migration'ını uygulamalı.",
      )
    }
    throw new Error(msg || 'Transfer yapılamadı.')
  }
  const row = data as { asset?: unknown; amount?: unknown } | null
  return {
    asset: typeof row?.asset === 'string' ? row.asset : 'DNZ',
    amount: typeof row?.amount === 'number' ? row.amount : amountDnz,
  }
}
