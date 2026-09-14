import { getSessionUserId } from '@/services/authService'

export interface SavedCard {
  id: string
  brand: string
  holderName: string
  /** Raw digits — CVC is intentionally NEVER stored. */
  number: string
  expiry: string
  savedAt: number
}

export const CARDS_STORAGE_KEY = 'deniztradx_cards'

export function cardsStorageKeyFor(userId: string): string {
  return `${CARDS_STORAGE_KEY}_${userId}`
}

function storageKey(): string | null {
  const uid = getSessionUserId()
  return uid ? cardsStorageKeyFor(uid) : null
}

let cardIdCounter = 0
function makeCardId(): string {
  cardIdCounter += 1
  return `card_${Date.now().toString(36)}_${cardIdCounter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function detectBrand(number: string): string {
  const d = number.replace(/\D/g, '')
  if (/^4/.test(d)) return 'VISA'
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(d)) return 'MASTERCARD'
  if (/^3[47]/.test(d)) return 'AMEX'
  if (/^9792/.test(d)) return 'TROY'
  return 'BANK'
}

export function maskCardNumber(number: string): string {
  const digits = number.replace(/\D/g, '').slice(0, 16)
  if (digits.length < 4) return digits
  return `${digits.slice(0, 4)} •••• •••• ${digits.slice(-4)}`
}

export function getSavedCards(): SavedCard[] {
  const key = storageKey()
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c: SavedCard): c is SavedCard =>
        Boolean(c) &&
        typeof c.id === 'string' &&
        typeof c.holderName === 'string' &&
        typeof c.number === 'string' &&
        typeof c.expiry === 'string',
    )
  } catch {
    return []
  }
}

export function saveCard(input: {
  holderName: string
  number: string
  expiry: string
}): SavedCard {
  const digits = input.number.replace(/\D/g, '').slice(0, 16)
  const card: SavedCard = {
    id: makeCardId(),
    brand: detectBrand(digits),
    holderName: input.holderName.trim(),
    number: digits,
    expiry: input.expiry,
    savedAt: Date.now(),
  }
  const withoutDuplicate = getSavedCards().filter((c) => c.number !== digits)
  const key = storageKey()
  if (!key) return card
  localStorage.setItem(
    key,
    JSON.stringify([card, ...withoutDuplicate]),
  )
  return card
}

export function deleteSavedCard(id: string): void {
  const key = storageKey()
  if (!key) return
  localStorage.setItem(
    key,
    JSON.stringify(getSavedCards().filter((c) => c.id !== id)),
  )
}

/**
 * Kararlı bir MM/YY kontrolü: ay 01–12 arasında, yıl (20YY) en az 27 (2027)
 * olmalı ve tarih henüz geçmiş olmamalıdır.
 */
export function isExpiryValid(expiry: string): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(expiry.trim())
  if (!match) return false
  const month = Number(match[1])
  const yearSuffix = Number(match[2])
  if (month < 1 || month > 12) return false
  if (yearSuffix < 27) return false
  const year = 2000 + yearSuffix
  const now = new Date()
  if (year < now.getFullYear()) return false
  if (year === now.getFullYear() && month < now.getMonth() + 1) return false
  return true
}