import { beforeEach, describe, expect, it } from 'vitest'
import { createAnnouncement, deleteAnnouncement, listAnnouncements } from '@/services/announcementService'

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
