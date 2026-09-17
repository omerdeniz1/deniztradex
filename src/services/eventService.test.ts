import { describe, expect, it } from 'vitest'
import {
  deleteEvent,
  EVENT_BODY_MAX,
  EVENT_TITLE_MAX,
  listActiveEvents,
  listEvents,
  saveEvent,
} from '@/services/eventService'

describe('eventService (çevrimdışı)', () => {
  it('liste boş döner (sayfada "aktif etkinlik yok" görünür)', async () => {
    await expect(listEvents()).resolves.toEqual([])
    await expect(listActiveEvents()).resolves.toEqual([])
  })

  it('yazım çevrimdışı hata fırlatır', async () => {
    await expect(
      saveEvent(null, { title: 'T', body: 'B', startsAt: '', endsAt: '', isActive: true }),
    ).rejects.toThrow()
    await expect(deleteEvent('x')).rejects.toThrow()
  })

  it('girdi doğrulaması limitleri uygular', () => {
    expect(EVENT_TITLE_MAX).toBe(120)
    expect(EVENT_BODY_MAX).toBe(2000)
  })
})
