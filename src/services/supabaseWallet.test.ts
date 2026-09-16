import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertDepositAllowed,
  assertWithdrawAllowed,
  getMoneyRestrictions,
  getProfileBalanceWithRetry,
  pushBalanceToServer,
  validateAvatarFile,
} from '@/services/supabaseWallet'

const mocks = vi.hoisted(() => {
  const maybeSingle = vi.fn()
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
    })),
    maybeSingle,
  }
})

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mocks.from },
}))

const profileRow = {
  id: 'user-1',
  username: 'deniz',
  email: 'deniz@tradex.com',
  full_name: null,
  avatar_url: null,
  balance: 10000,
  created_at: new Date().toISOString(),
}

beforeEach(() => {
  mocks.from.mockClear()
  mocks.maybeSingle.mockReset()
})

describe('getProfileBalanceWithRetry', () => {
  it('returns the balance when the profile row exists on the first attempt', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: profileRow, error: null })

    const balance = await getProfileBalanceWithRetry('user-1')
    expect(balance).toBe(10000)
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('waits and retries until the profile row (DB trigger) shows up', async () => {
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: profileRow, error: null })

    const balance = await getProfileBalanceWithRetry('user-1', 5, 10)
    expect(balance).toBe(10000)
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(3)
  })

  it('gives up and returns null after all attempts without crashing', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null })

    const balance = await getProfileBalanceWithRetry('user-1', 3, 5)
    expect(balance).toBeNull()
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(3)
  })

  it('returns null immediately when the user id is missing', async () => {
    const balance = await getProfileBalanceWithRetry('')
    expect(balance).toBeNull()
    expect(mocks.from).not.toHaveBeenCalled()
  })
})

describe('validateAvatarFile', () => {
  it('accepts common image types with correct extensions', () => {
    expect(validateAvatarFile(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))).toBe('jpg')
    expect(validateAvatarFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBe('png')
    expect(validateAvatarFile(new File(['x'], 'a.webp', { type: 'image/webp' }))).toBe('webp')
  })

  it('rejects non-image files', () => {
    expect(() => validateAvatarFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).toThrow()
    expect(() => validateAvatarFile(new File(['x'], 'a.pdf', { type: 'application/pdf' }))).toThrow()
  })

  it('rejects files larger than 10MB', () => {
    const big = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    expect(() => validateAvatarFile(big)).toThrow('10MB')
  })

  it('accepts files up to 10MB', () => {
    const ok = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(ok, 'size', { value: 9 * 1024 * 1024 })
    expect(validateAvatarFile(ok)).toBe('png')
  })
})

describe('money restrictions', () => {
  it('returns open restrictions when the backend is mocked without rows', async () => {
    // Bu dosyada supabase mock'lu; maybeSingle boş dönerse kısıt yok sayılır.
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null })
    await expect(getMoneyRestrictions('user-1')).resolves.toEqual({
      depositBlocked: false,
      withdrawBlocked: false,
    })
  })

  it('blocks deposits and withdrawals when flagged', () => {
    expect(() =>
      assertDepositAllowed({ depositBlocked: true, withdrawBlocked: false }),
    ).toThrow('yatırma')
    expect(() =>
      assertWithdrawAllowed({ depositBlocked: false, withdrawBlocked: true }),
    ).toThrow('çekme')
    expect(() =>
      assertDepositAllowed({ depositBlocked: false, withdrawBlocked: true }),
    ).not.toThrow()
    expect(() =>
      assertWithdrawAllowed({ depositBlocked: true, withdrawBlocked: false }),
    ).not.toThrow()
  })
})

describe('pushBalanceToServer', () => {
  it('resolves silently without a usable backend', async () => {
    await expect(pushBalanceToServer('', 100)).resolves.toBeUndefined()
    await expect(pushBalanceToServer('user-1', 100)).resolves.toBeUndefined()
    await expect(pushBalanceToServer('user-1', -5)).resolves.toBeUndefined()
  })
})