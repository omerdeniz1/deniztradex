import { beforeEach, describe, expect, it } from 'vitest'
import {
  findPersona,
  followUser,
  formatFollowCount,
  getPublicProfile,
  PERSONAS,
  unfollowUser,
  validateDisplayName,
} from '@/services/profileService'
import type { User } from '@/types'

const alice: User = { id: 'u_alice', username: 'alice', email: 'a@x.com', createdAt: 1 }

function loginAs(user: User | null) {
  if (user) localStorage.setItem('deniztradx_session', JSON.stringify(user))
  else localStorage.removeItem('deniztradx_session')
}

beforeEach(() => {
  localStorage.clear()
})

describe('profileService personae', () => {
  it('3 senaryo hesabı sabit sayılarla tanımlı', () => {
    expect(PERSONAS).toHaveLength(3)
    const byName = Object.fromEntries(PERSONAS.map((p) => [p.username.toLowerCase(), p]))
    expect(byName['deniztradexx']).toMatchObject({ followerBase: 1700000, verifiedTier: 'super' })
    expect(byName['omerbabaparayapmakta']).toMatchObject({ followerBase: 800000, verifiedTier: 'admin' })
    expect(byName['blackrock']).toMatchObject({ followerBase: 780000, verifiedTier: 'admin' })
  })

  it('findPersona büyük-küçük harf duyarsız bulur', () => {
    expect(findPersona('DENIZTRADEXx')?.displayName).toBe('DenizTradeX')
    expect(findPersona('bilinmez')).toBeNull()
  })

  it('formatFollowCount tr-TR kısaltır', () => {
    expect(formatFollowCount(1700000)).toBe('1,7 Mn')
    expect(formatFollowCount(800000)).toBe('800 B')
    expect(formatFollowCount(25300)).toBe('25,3 B')
    expect(formatFollowCount(950)).toBe('950')
    expect(formatFollowCount(0)).toBe('0')
  })
})

describe('validateDisplayName', () => {
  it('boş, uzun ve yasak karakterli ismi reddeder', () => {
    expect(() => validateDisplayName('   ')).toThrow('boş')
    expect(() => validateDisplayName('x'.repeat(31))).toThrow('30')
    expect(() => validateDisplayName('kötü<isim')).toThrow()
    expect(() => validateDisplayName('ad@x')).toThrow()
    expect(validateDisplayName('  Kripto   Balinası  ')).toBe('Kripto Balinası')
  })
})

describe('profileService (çevrimdışı)', () => {
  it('persona profili tabanla gelir', async () => {
    const p = await getPublicProfile('blackrock')
    expect(p).toMatchObject({ handle: 'blackrock', followers: 780000, isPersona: true, isFollowing: false })
  })

  it('bilinmeyen ad null döner', async () => {
    await expect(getPublicProfile('kimseboylebiri')).resolves.toBeNull()
    await expect(getPublicProfile('  ')).resolves.toBeNull()
  })

  it('girişsiz takip reddedilir', async () => {
    loginAs(null)
    await expect(followUser('blackrock')).rejects.toThrow('giriş')
  })

  it('takip tabanın üstüne eklenir, bırakınca tabana döner (düşmez)', async () => {
    loginAs(alice)
    await expect(followUser('blackrock')).resolves.toBe(780001)
    await expect(unfollowUser('blackrock')).resolves.toBe(780000)
  })
})
