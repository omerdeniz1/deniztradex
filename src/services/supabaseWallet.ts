import { supabase } from '@/lib/supabase'

export interface Profile {
  id: string
  username: string
  email: string
  full_name: string | null
  avatar_url: string | null
  balance: number
  created_at: string
}

export type DepositSource = 'card' | 'promo' | 'referral'

interface DbProfile {
  id: string
  username: string
  email: string
  full_name: string | null
  avatar_url: string | null
  balance: number | string | null
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
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    full_name: row.full_name,
    avatar_url: row.avatar_url,
    balance,
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

export async function findProfileByEmail(email: string): Promise<Profile | null> {
  if (!supabase || !email) return null
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle()
    if (error || !data) return null
    return parseProfile(data as DbProfile)
  } catch {
    return null
  }
}

export async function findProfileByUsername(username: string): Promise<Profile | null> {
  if (!supabase || !username) return null
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username.trim())
      .maybeSingle()
    if (error || !data) return null
    return parseProfile(data as DbProfile)
  } catch {
    return null
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