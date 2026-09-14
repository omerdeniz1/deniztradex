import { getSessionUserId } from '@/services/authService'

export type WithdrawMethodType = 'card' | 'iban'

export interface SavedWithdrawMethod {
  id: string
  method: WithdrawMethodType
  /** Raw digits / IBAN string (spaces stripped) — the payment destination. */
  accountNumber: string
  holderName: string
  savedAt: number
}

export const WITHDRAW_METHODS_STORAGE_KEY = 'savedWithdrawMethods'

export function withdrawMethodsStorageKeyFor(userId: string): string {
  return `${WITHDRAW_METHODS_STORAGE_KEY}_${userId}`
}

function storageKey(): string | null {
  const uid = getSessionUserId()
  return uid ? withdrawMethodsStorageKeyFor(uid) : null
}

let methodIdCounter = 0
function makeMethodId(): string {
  methodIdCounter += 1
  return `mth_${Date.now().toString(36)}_${methodIdCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

export function normalizeAccount(method: WithdrawMethodType, raw: string): string {
  return method === 'card'
    ? raw.replace(/\D/g, '')
    : raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function maskWithdrawAccount(method: WithdrawMethodType, accountNumber: string): string {
  const value = normalizeAccount(method, accountNumber)
  if (value.length <= 6) return value
  return `${value.slice(0, 4)} •••• ${value.slice(-4)}`
}

export function getSavedWithdrawMethods(): SavedWithdrawMethod[] {
  const key = storageKey()
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (m: SavedWithdrawMethod): m is SavedWithdrawMethod =>
        Boolean(m) &&
        typeof m.id === 'string' &&
        (m.method === 'card' || m.method === 'iban') &&
        typeof m.accountNumber === 'string' &&
        typeof m.holderName === 'string',
    )
  } catch {
    return []
  }
}

export function saveWithdrawMethod(input: {
  method: WithdrawMethodType
  accountNumber: string
  holderName: string
}): SavedWithdrawMethod {
  const accountNumber = normalizeAccount(input.method, input.accountNumber)
  const methodEntry: SavedWithdrawMethod = {
    id: makeMethodId(),
    method: input.method,
    accountNumber,
    holderName: input.holderName.trim(),
    savedAt: Date.now(),
  }
  const withoutDuplicate = getSavedWithdrawMethods().filter(
    (m) => !(m.method === methodEntry.method && m.accountNumber === methodEntry.accountNumber),
  )
  const key = storageKey()
  if (!key) return methodEntry
  localStorage.setItem(
    key,
    JSON.stringify([methodEntry, ...withoutDuplicate]),
  )
  return methodEntry
}

export function deleteSavedWithdrawMethod(id: string): void {
  const key = storageKey()
  if (!key) return
  localStorage.setItem(
    key,
    JSON.stringify(getSavedWithdrawMethods().filter((m) => m.id !== id)),
  )
}