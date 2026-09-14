import { beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSavedCard,
  getSavedCards,
  cardsStorageKeyFor,
  isExpiryValid,
  maskCardNumber,
  saveCard,
} from '@/services/cards'

const SESSION_USER = {
  id: 'usr_test_1',
  username: 'deniz',
  email: 'deniz@x.com',
  createdAt: 1,
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('deniztradx_session', JSON.stringify(SESSION_USER))
})

describe('saveCard', () => {
  it('persists holder, number and expiry but never CVC', () => {
    saveCard({ holderName: 'DENIZ DEMO', number: '4242424242424242', expiry: '12/29' })

    const cards = getSavedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      holderName: 'DENIZ DEMO',
      number: '4242424242424242',
      expiry: '12/29',
      brand: 'VISA',
    })
    expect((cards[0] as unknown as Record<string, unknown>).cvc).toBeUndefined()

    const raw = JSON.parse(localStorage.getItem(cardsStorageKeyFor('usr_test_1')) ?? '[]') as Array<
      Record<string, unknown>
    >
    expect(raw[0].cvc).toBeUndefined()
  })

  it('dedupes by card number, keeping the newest entry', () => {
    saveCard({ holderName: 'FIRST', number: '4111111111111111', expiry: '12/29' })
    saveCard({ holderName: 'SECOND', number: '4111111111111111', expiry: '01/30' })

    const cards = getSavedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].holderName).toBe('SECOND')
  })

  it('detects common card brands', () => {
    expect(
      saveCard({ holderName: 'V', number: '4242424242424242', expiry: '12/29' }).brand,
    ).toBe('VISA')
    expect(
      saveCard({ holderName: 'M', number: '5555555555554444', expiry: '12/29' }).brand,
    ).toBe('MASTERCARD')
    expect(
      saveCard({ holderName: 'A', number: '378282246310005', expiry: '12/29' }).brand,
    ).toBe('AMEX')
  })
})

describe('deleteSavedCard', () => {
  it('removes only the selected card', () => {
    const first = saveCard({ holderName: 'A', number: '4242424242424242', expiry: '12/29' })
    saveCard({ holderName: 'B', number: '5555555555554444', expiry: '12/29' })

    deleteSavedCard(first.id)

    const cards = getSavedCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].holderName).toBe('B')
  })
})

describe('maskCardNumber', () => {
  it('masks the middle digits', () => {
    expect(maskCardNumber('4242 4242 4242 4242')).toBe('4242 •••• •••• 4242')
  })
})

describe('isExpiryValid', () => {
  it('accepts a future date with a year of 27 or later', () => {
    expect(isExpiryValid('12/29')).toBe(true)
    expect(isExpiryValid('01/27')).toBe(true)
    expect(isExpiryValid('01/28')).toBe(true)
  })

  it('rejects years before 2027 (e.g. 11/01)', () => {
    expect(isExpiryValid('11/01')).toBe(false)
    expect(isExpiryValid('09/26')).toBe(false)
    expect(isExpiryValid('12/25')).toBe(false)
  })

  it('rejects months outside 01–12', () => {
    expect(isExpiryValid('00/29')).toBe(false)
    expect(isExpiryValid('13/29')).toBe(false)
    expect(isExpiryValid('99/30')).toBe(false)
  })

  it('rejects malformed values', () => {
    expect(isExpiryValid('')).toBe(false)
    expect(isExpiryValid('1229')).toBe(false)
    expect(isExpiryValid('12/9')).toBe(false)
    expect(isExpiryValid('ab/cd')).toBe(false)
  })
})