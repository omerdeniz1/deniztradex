import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProfileBalanceWithRetry } from '@/services/supabaseWallet'

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