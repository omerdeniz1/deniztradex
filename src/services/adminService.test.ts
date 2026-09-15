import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkIsAdmin,
  getPlatformStats,
  listAdminUsers,
  setUserFrozen,
  updateUserBalance,
  validateBalanceInput,
} from '@/services/adminService'

const alice = { id: 'u_alice', username: 'alice', email: 'a@x.com', createdAt: 1 }

function loginAs(user: typeof alice | null) {
  if (user) localStorage.setItem('deniztradx_session', JSON.stringify(user))
  else localStorage.removeItem('deniztradx_session')
}

beforeEach(() => {
  localStorage.clear()
})

describe('adminService (offline — Supabase yok)', () => {
  it('denies admin without session or backend', async () => {
    loginAs(null)
    await expect(checkIsAdmin()).resolves.toBe(false)
    loginAs(alice)
    // Test modunda Supabase istemcisi kurulmaz → her zaman false.
    await expect(checkIsAdmin()).resolves.toBe(false)
  })

  it('refuses data access without backend (no silent fallback)', async () => {
    loginAs(alice)
    await expect(listAdminUsers()).rejects.toThrow()
    await expect(getPlatformStats()).rejects.toThrow()
  })

  it('validates balance input', () => {
    expect(validateBalanceInput('1500')).toBe(1500)
    expect(validateBalanceInput('1234,56')).toBe(1234.56)
    expect(validateBalanceInput(' 2500.75 ')).toBe(2500.75)
    expect(validateBalanceInput('0')).toBe(0)
    expect(() => validateBalanceInput('-5')).toThrow()
    expect(() => validateBalanceInput('abc')).toThrow()
    expect(() => validateBalanceInput('')).toThrow()
  })

  it('rejects invalid balance updates before touching the backend', async () => {
    loginAs(alice)
    await expect(updateUserBalance('u_bob', -10)).rejects.toThrow()
    await expect(updateUserBalance('u_bob', Number.NaN)).rejects.toThrow()
    await expect(updateUserBalance('', 100)).rejects.toThrow('Kullanıcı bulunamadı')
  })

  it('rejects freeze without a user', async () => {
    loginAs(alice)
    await expect(setUserFrozen('', true)).rejects.toThrow('Kullanıcı bulunamadı')
  })
})
