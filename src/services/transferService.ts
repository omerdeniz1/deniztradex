import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser, getSessionUserId } from '@/services/authService'
import { deriveWalletNo, getProfile } from '@/services/supabaseWallet'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore, DNZ_STORAGE_KEY, type DnzLedgerEntry } from '@/store/dnzStore'
import { transferDnzRemote } from '@/services/dnzService'
import { getVirtualHoldings } from '@/services/virtualMarketService'

/**
 * Hesaplar arası transfer (USDT + spot coin + sanal coin).
 *
 * - Supabase varken TEK kaynak `transfer_assets` RPC'sidir: bakiyeler
 *   satır kilidiyle taşınır, iki tarafa defter satırı yazılır, eski
 *   kullanıcı adı/kayıt yapısı aynen korunur.
 * - Yerelde (test/çevrimdışı) aynı cihazın kullanıcı kayıtları arasında
 *   doğrudan aktarım yapılır (USDT + spot; sanal bakiyeler yerelde
 *   cihaz-ortak defterde tutulduğu için transfer anlamsızdır).
 */

export interface TransferTarget {
  walletNo: string
  username: string
}

export interface TransferRecord {
  id: string
  direction: 'in' | 'out'
  asset: string
  amount: number
  counterparty: string
  at: number
}

function normalizeWallet(raw: string): string {
  return raw.trim().toUpperCase()
}

/** Bu hesabın cüzdan numarası (transfer adresi). */
export async function getMyWalletNo(): Promise<string> {
  const userId = getSessionUserId()
  if (!userId) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')
  if (isSupabaseConfigured && supabase) {
    try {
      const profile = await getProfile(userId)
      if (profile?.wallet_no) return profile.wallet_no
    } catch {
      // yerele düş
    }
  }
  return deriveWalletNo(userId)
}

/**
 * Alıcı arama: cüzdan no (WT-XXXXXXXX) veya kullanıcı adı.
 * Uzakta `lookup_wallet` RPC'si yalnızca no+ad döndürür (bakiye sızmaz).
 */
export async function lookupTransferTarget(query: string): Promise<TransferTarget> {
  const q = query.trim()
  if (!q) throw new Error('Alıcı cüzdan numarası veya kullanıcı adı gir.')
  const me = getSessionUserId()

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('lookup_wallet', { p_q: q })
    if (error) {
      const msg = String((error as { message?: unknown }).message ?? '')
      if (/bulunamadı/i.test(msg)) throw new Error('Alıcı bulunamadı.')
      if ((error as { code?: string }).code === 'PGRST202') {
        throw new Error(
          "Transfer altyapısı veritabanında yok. Yönetici Supabase SQL Editor'de 20260918130000_wallet_transfer migration'ını uygulamalı.",
        )
      }
      throw new Error('Alıcı aranamadı. Lütfen tekrar dene.')
    }
    const row = data as { wallet_no?: unknown; username?: unknown } | null
    const walletNo = typeof row?.wallet_no === 'string' ? row.wallet_no : ''
    const username = typeof row?.username === 'string' ? row.username : ''
    if (!walletNo) throw new Error('Alıcı bulunamadı.')
    if (me) {
      const mine = await getMyWalletNo().catch(() => '')
      if (mine && normalizeWallet(walletNo) === normalizeWallet(mine)) {
        throw new Error('Kendine transfer yapamazsın.')
      }
    }
    return { walletNo, username: username || 'Kullanıcı' }
  }

  // Yerel mod: aynı cihazın kayıtları arasında ara.
  try {
    const raw = localStorage.getItem('deniztradx_users')
    const users = raw ? (JSON.parse(raw) as { id: string; username: string }[]) : []
    const found = users.find(
      (u) =>
        normalizeWallet(deriveWalletNo(u.id)) === normalizeWallet(q) ||
        u.username.toLowerCase() === q.toLowerCase(),
    )
    if (!found) throw new Error('Alıcı bulunamadı.')
    if (me && found.id === me) throw new Error('Kendine transfer yapamazsın.')
    return { walletNo: deriveWalletNo(found.id), username: found.username }
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error('Alıcı aranamadı. Lütfen tekrar dene.')
  }
}

/**
 * Varlık gönderir. `asset`: 'USDT', spot coin ('BTC'), sanal
 * sembol ('ENTES') veya borsa tokenı ('DNZ'). Tutar USDT'de para,
 * coinlerde adettir.
 */
export async function transferAsset(
  toWallet: string,
  asset: string,
  amount: number,
): Promise<{ asset: string; amount: number }> {
  const target = normalizeWallet(toWallet)
  if (!target) throw new Error('Alıcı cüzdan numarası gerekli.')
  const coin = asset.trim().toUpperCase()
  if (!coin) throw new Error('Varlık seç.')
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Geçerli bir tutar gir.')
  }
  const userId = getSessionUserId()
  if (!userId) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')

  // DNZ borsa tokenı: kendi defteri (`dnz_balances`/`dnz_ledger`) üzerinden taşınır.
  if (coin === 'DNZ') {
    if (isSupabaseConfigured && supabase) {
      const res = await transferDnzRemote(target, amount)
      try {
        await useDnzStore.getState().refreshRemote()
      } catch {
        // yoksay — yerel bakiye RPC sonrası ayrıca eşitlenir
      }
      return res
    }
    return transferDnzLocal(userId, target, amount)
  }

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('transfer_assets', {
      p_receiver_wallet: target,
      p_asset: coin,
      p_amount: amount,
    })
    if (error) {
      const msg = String((error as { message?: unknown }).message ?? '')
      if (/bulunamadı/i.test(msg)) throw new Error('Alıcı bulunamadı.')
      if (/kendine/i.test(msg)) throw new Error('Kendine transfer yapamazsın.')
      if (/yetersiz/i.test(msg)) throw new Error(msg)
      if (/tutar/i.test(msg)) throw new Error('Geçerli bir tutar gir.')
      if ((error as { code?: string }).code === 'PGRST202') {
        throw new Error(
          "Transfer altyapısı veritabanında yok. Yönetici Supabase SQL Editor'de 20260918130000_wallet_transfer migration'ını uygulamalı.",
        )
      }
      throw new Error(msg || 'Transfer yapılamadı.')
    }
    const row = data as { asset?: unknown; amount?: unknown } | null
    return {
      asset: typeof row?.asset === 'string' ? row.asset : coin,
      amount: typeof row?.amount === 'number' ? row.amount : amount,
    }
  }

  return transferLocal(userId, target, coin, amount)
}

// ---------------------------------------------------------------
// Yerel (çevrimdışı) aktarım — aynı cihazın kullanıcı kayıtları.
// Cüzdan blob'u zustand persist formatındadır ({state:{...}}).
// ---------------------------------------------------------------

const WALLET_KEY = 'deniztradx_wallet'
const TRANSFERS_KEY = 'deniztradx_transfers'

interface LocalWalletState {
  balance?: number
  spotBalances?: Record<string, number>
  spotAvgCosts?: Record<string, number>
}

function readLocalWalletBlob(uid: string): { state: LocalWalletState } | null {
  try {
    const raw = localStorage.getItem(`${WALLET_KEY}_${uid}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: LocalWalletState }
    if (!parsed || typeof parsed.state !== 'object') return null
    return { state: parsed.state }
  } catch {
    return null
  }
}

function findLocalUserId(target: string): { id: string; username: string } | null {
  try {
    const raw = localStorage.getItem('deniztradx_users')
    const users = raw ? (JSON.parse(raw) as { id: string; username: string }[]) : []
    return (
      users.find((u) => normalizeWallet(deriveWalletNo(u.id)) === target) ?? null
    )
  } catch {
    return null
  }
}

function logLocalTransfer(uid: string, rec: TransferRecord): void {
  try {
    const raw = localStorage.getItem(`${TRANSFERS_KEY}_${uid}`)
    const list = raw ? (JSON.parse(raw) as TransferRecord[]) : []
    localStorage.setItem(`${TRANSFERS_KEY}_${uid}`, JSON.stringify([rec, ...list].slice(0, 50)))
  } catch {
    // yoksay
  }
}

function transferLocal(
  senderId: string,
  target: string,
  coin: string,
  amount: number,
): { asset: string; amount: number } {
  const receiver = findLocalUserId(target)
  if (!receiver) throw new Error('Alıcı bulunamadı.')
  if (receiver.id === senderId) throw new Error('Kendine transfer yapamazsın.')

  const trade = useTradeStore.getState()

  if (coin === 'USDT') {
    if (trade.balance < amount) throw new Error('Yetersiz USDT bakiyesi.')
    trade.setBalance(Math.max(0, Math.round((trade.balance - amount) * 100) / 100))
    const blob = readLocalWalletBlob(receiver.id)
    const next = Math.round(((blob?.state.balance ?? 0) + amount) * 100) / 100
    try {
      localStorage.setItem(
        `${WALLET_KEY}_${receiver.id}`,
        JSON.stringify({ state: { ...(blob?.state ?? {}), balance: next }, version: 0 }),
      )
    } catch {
      throw new Error('Alıcı cüzdanı yazılamadı.')
    }
  } else if (/^[A-Z0-9-]{2,12}$/.test(coin) && !isVirtualSymbolLocal(coin)) {
    const held = trade.spotBalances[coin] ?? 0
    if (held < amount) throw new Error(`Yetersiz ${coin} bakiyesi.`)
    const senderAvg = trade.spotAvgCosts[coin] ?? 0
    // Gönderen taraf tradeStore üzerinden düşer (persist otomatik).
    // Miktar sıfırlanırsa maliyet kaydı da silinir (spotSell ile aynı kural).
    useTradeStore.setState((s) => {
      const nextQty = Math.round(Math.max(0, (s.spotBalances[coin] ?? 0) - amount) * 1e8) / 1e8
      const nextAvg = { ...s.spotAvgCosts }
      if (nextQty <= 0) delete nextAvg[coin]
      return {
        spotBalances: { ...s.spotBalances, [coin]: nextQty },
        spotAvgCosts: nextAvg,
      }
    })
    const blob = readLocalWalletBlob(receiver.id)
    const rQty = (blob?.state.spotBalances?.[coin] ?? 0) + amount
    const rPrevAvg = blob?.state.spotAvgCosts?.[coin] ?? 0
    const rPrevQty = (blob?.state.spotBalances?.[coin] ?? 0)
    const rAvg = senderAvg > 0 && rQty > 0
      ? (rPrevQty * rPrevAvg + amount * senderAvg) / rQty
      : rPrevAvg
    try {
      localStorage.setItem(
        `${WALLET_KEY}_${receiver.id}`,
        JSON.stringify({
          state: {
            ...(blob?.state ?? {}),
            spotBalances: { ...(blob?.state.spotBalances ?? {}), [coin]: rQty },
            spotAvgCosts: { ...(blob?.state.spotAvgCosts ?? {}), [coin]: rAvg },
          },
          version: 0,
        }),
      )
    } catch {
      throw new Error('Alıcı cüzdanı yazılamadı.')
    }
  } else {
    throw new Error('Çevrimdışı modda bu varlık transfer edilemez (USDT veya spot coin dene).')
  }

  const at = Date.now()
  const id = `tr_${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  logLocalTransfer(senderId, { id, direction: 'out', asset: coin, amount, counterparty: receiver.username, at })
  logLocalTransfer(receiver.id, {
    id,
    direction: 'in',
    asset: coin,
    amount,
    counterparty: getSessionUser()?.username ?? '',
    at,
  })
  return { asset: coin, amount }
}

/** Yerel sanal sembol kabulu (sunucusuz tohum listesi — DNZ dahil). */
function isVirtualSymbolLocal(coin: string): boolean {
  return ['DNZ', 'ENTES', 'V-XAU', 'V-XAG', 'RGC', 'MPRC', 'SVGC'].includes(coin)
}

// ---------------------------------------------------------------
// Yerel DNZ aktarımı — aynı cihazın kullanıcı kayıtları arasında.
// DNZ blob'u dnz store persist formatındadır ({state:{...}}).
// ---------------------------------------------------------------

interface LocalDnzState {
  balance?: number
  avgCost?: number
  ledger?: DnzLedgerEntry[]
}

function readLocalDnzBlob(uid: string): { state: LocalDnzState } | null {
  try {
    const raw = localStorage.getItem(`${DNZ_STORAGE_KEY}_${uid}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: LocalDnzState }
    if (!parsed || typeof parsed.state !== 'object') return null
    return { state: parsed.state }
  } catch {
    return null
  }
}

function transferDnzLocal(
  senderId: string,
  target: string,
  amount: number,
): { asset: string; amount: number } {
  const receiver = findLocalUserId(target)
  if (!receiver) throw new Error('Alıcı bulunamadı.')
  if (receiver.id === senderId) throw new Error('Kendine transfer yapamazsın.')

  const dnz = useDnzStore.getState()
  if (amount > dnz.balance) throw new Error('Yetersiz DNZ bakiyesi.')
  dnz.applyTransferOut(amount, receiver.username)

  const blob = readLocalDnzBlob(receiver.id)
  const rQty = Math.round(((blob?.state.balance ?? 0) + amount) * 1e8) / 1e8
  const entry: DnzLedgerEntry = {
    id: `dnz_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: 'transfer_in',
    amountDnz: amount,
    priceUsdt: null,
    amountUsdt: null,
    balanceAfter: rQty,
    at: Date.now(),
  }
  try {
    localStorage.setItem(
      `${DNZ_STORAGE_KEY}_${receiver.id}`,
      JSON.stringify({
        state: {
          ...(blob?.state ?? {}),
          balance: rQty,
          ledger: [entry, ...((blob?.state.ledger ?? []) as DnzLedgerEntry[])].slice(0, 100),
        },
        version: 0,
      }),
    )
  } catch {
    throw new Error('Alıcı cüzdanı yazılamadı.')
  }

  const at = Date.now()
  const id = `tr_${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  logLocalTransfer(senderId, { id, direction: 'out', asset: 'DNZ', amount, counterparty: receiver.username, at })
  logLocalTransfer(receiver.id, {
    id,
    direction: 'in',
    asset: 'DNZ',
    amount,
    counterparty: getSessionUser()?.username ?? '',
    at,
  })
  return { asset: 'DNZ', amount }
}

/** Son transferler (uzak defter veya yerel kayıt). */
export async function listTransferHistory(limit = 20): Promise<TransferRecord[]> {
  const userId = getSessionUserId()
  if (!userId) return []
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('type,symbol,quantity,amount_usdt,created_at')
        .eq('user_id', userId)
        .in('type', ['transfer_in', 'transfer_out'])
        .order('created_at', { ascending: false })
        .limit(Math.min(Math.max(limit, 1), 50))
      if (error || !Array.isArray(data)) return []
      return (data as Record<string, unknown>[]).map((r, i) => {
        const sym = typeof r.symbol === 'string' && r.symbol ? r.symbol.replace(/USDT$/i, '') : 'USDT'
        const qty = typeof r.quantity === 'number' ? r.quantity : 0
        const usdt = typeof r.amount_usdt === 'number' ? r.amount_usdt : 0
        return {
          id: `remote_${i}_${String(r.created_at ?? '')}`,
          direction: r.type === 'transfer_in' ? 'in' : 'out',
          asset: sym,
          amount: sym === 'USDT' ? usdt : qty || usdt,
          counterparty: '',
          at: Date.parse(String(r.created_at ?? '')) || 0,
        }
      })
    } catch {
      return []
    }
  }
  try {
    const raw = localStorage.getItem(`${TRANSFERS_KEY}_${userId}`)
    const list = raw ? (JSON.parse(raw) as TransferRecord[]) : []
    return Array.isArray(list) ? list.slice(0, limit) : []
  } catch {
    return []
  }
}

/** Gönderilebilir varlıklar: USDT + eldeki spot + eldeki sanal + DNZ. */
export async function listTransferableAssets(): Promise<{ asset: string; qty: number; kind: 'usdt' | 'spot' | 'virtual' | 'dnz' }[]> {
  const s = useTradeStore.getState()
  const out: { asset: string; qty: number; kind: 'usdt' | 'spot' | 'virtual' | 'dnz' }[] = [
    { asset: 'USDT', qty: s.balance, kind: 'usdt' },
  ]
  for (const [coin, qty] of Object.entries(s.spotBalances)) {
    if (qty > 0) out.push({ asset: coin, qty, kind: 'spot' })
  }
  const dnzBalance = useDnzStore.getState().balance
  if (dnzBalance > 0) out.push({ asset: 'DNZ', qty: dnzBalance, kind: 'dnz' })
  try {
    const held = await getVirtualHoldings()
    for (const [sym, qty] of Object.entries(held)) {
      // DNZ yukarıda ayrı girdidir (transfer_dnz yolu) — çift listeleme olmasın.
      if (sym === 'DNZ') continue
      if (qty > 0) out.push({ asset: sym, qty, kind: 'virtual' })
    }
  } catch {
    // yoksay
  }
  return out
}
