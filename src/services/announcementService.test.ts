import { beforeEach, describe, expect, it } from 'vitest'
import {
  ANNOUNCEMENT_BANNER_VISIBILITY_MS,
  createAnnouncement,
  deleteAnnouncement,
  isAnnouncementVisible,
  listAnnouncements,
} from '@/services/announcementService'

beforeEach(() => {
  localStorage.clear()
})

describe('announcementService (offline — Supabase yok)', () => {
  it('listesi boş döner, banner gizlenir', async () => {
    await expect(listAnnouncements()).resolves.toEqual([])
  })

  it('yazım çevrimdışıyken hata fırlatır', async () => {
    await expect(createAnnouncement('Bakım', 'Yarın 03:00 bakım var.')).rejects.toThrow()
    await expect(deleteAnnouncement('x')).rejects.toThrow()
  })

  it('boş başlık/metin reddedilir (oturumdan önce bile doğrulama çalışır)', async () => {
    await expect(createAnnouncement('  ', 'metin')).rejects.toThrow('Duyuru başlığı')
    await expect(createAnnouncement('başlık', '   ')).rejects.toThrow('Duyuru metni')
  })
})

describe('isAnnouncementVisible (1 saat kuralı)', () => {
  const HOUR = ANNOUNCEMENT_BANNER_VISIBILITY_MS

  it('hiç görülmemiş duyuru gösterilir', () => {
    expect(isAnnouncementVisible(null, 1_000_000)).toBe(true)
    expect(isAnnouncementVisible(undefined, 1_000_000)).toBe(true)
  })

  it('1 saat dolmadan çıkış+girişte tekrar gösterilir', () => {
    const firstSeen = 1_000_000
    expect(isAnnouncementVisible(firstSeen, firstSeen + HOUR - 1000)).toBe(true)
  })

  it('1 saat dolunca bir daha gösterilmez', () => {
    const firstSeen = 1_000_000
    expect(isAnnouncementVisible(firstSeen, firstSeen + HOUR)).toBe(false)
    expect(isAnnouncementVisible(firstSeen, firstSeen + HOUR + 5000)).toBe(false)
  })
})
