import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALL_ADMIN_PERMISSION_KEYS,
  checkIsAdmin,
  deleteForumPostsBulk,
  getMyAdminAccess,
  getPlatformStats,
  hasAdminPermission,
  listAdminUsers,
  listForumAdminPosts,
  setUserBanned,
  setUserFrozen,
  updateUserBalance,
  validateBalanceInput,
  type AdminAccess,
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
    await expect(listForumAdminPosts()).rejects.toThrow()
    await expect(deleteForumPostsBulk(['post_1'])).rejects.toThrow()
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

  it('rejects freeze/ban without a user', async () => {
    loginAs(alice)
    await expect(setUserFrozen('', true)).rejects.toThrow('Kullanıcı bulunamadı')
    await expect(setUserBanned('', true)).rejects.toThrow('Kullanıcı bulunamadı')
  })

  it('grants no access offline', async () => {
    loginAs(alice)
    await expect(getMyAdminAccess()).resolves.toEqual({ isSuperAdmin: false, permissions: [] })
  })
})

describe('admin RBAC helpers', () => {
  it('exposes the four documented permissions', () => {
    expect([...ALL_ADMIN_PERMISSION_KEYS].sort()).toEqual(
      ['ban_users', 'change_password', 'edit_balance', 'manage_admins'].sort(),
    )
  })

  it('super admin passes every permission check', () => {
    const super_admin: AdminAccess = { isSuperAdmin: true, permissions: [] }
    for (const perm of ALL_ADMIN_PERMISSION_KEYS) {
      expect(hasAdminPermission(super_admin, perm)).toBe(true)
    }
  })

  it('sub-admin passes only granted permissions', () => {
    const sub: AdminAccess = { isSuperAdmin: false, permissions: ['edit_balance'] }
    expect(hasAdminPermission(sub, 'edit_balance')).toBe(true)
    expect(hasAdminPermission(sub, 'ban_users')).toBe(false)
    expect(hasAdminPermission(sub, 'manage_admins')).toBe(false)
  })
})
