import { describe, expect, it } from 'vitest'
import {
  MAX_MENTIONS_PER_POST,
  extractMentions,
  listMentionNotifications,
  markMentionsRead,
  notifyMentions,
} from '@/services/notificationService'

describe('extractMentions', () => {
  it('finds @usernames in text', () => {
    expect(extractMentions('selam @deniz nasılsın')).toEqual(['deniz'])
    expect(extractMentions('@ali ve @veli, @ali tekrar')).toEqual(['ali', 'veli'])
  })

  it('matches at the start of the text and after punctuation', () => {
    expect(extractMentions('@denizTrade günaydın')).toEqual(['denizTrade'])
    expect(extractMentions('hey,@deniz bak')).toEqual(['deniz'])
  })

  it('supports Turkish characters', () => {
    expect(extractMentions('@çağlar merhaba, @GÖKHAN naber')).toEqual(['çağlar', 'GÖKHAN'])
  })

  it('ignores emails and too-short names', () => {
    expect(extractMentions('eposta test@ornek.com değil')).toEqual([])
    expect(extractMentions('@ab çok kısa')).toEqual([])
    expect(extractMentions('düz metin')).toEqual([])
  })

  it('caps the number of mentions per post', () => {
    const text = '@a1x @b2x @c3x @d4x @e5x @f6x @g7x'
    const found = extractMentions(text)
    expect(found).toHaveLength(MAX_MENTIONS_PER_POST)
    expect(found).toEqual(['a1x', 'b2x', 'c3x', 'd4x', 'e5x'])
  })
})

describe('notificationService (offline — Supabase yok)', () => {
  it('returns empty lists and never throws', async () => {
    await expect(listMentionNotifications()).resolves.toEqual([])
    await expect(markMentionsRead()).resolves.toBeUndefined()
    await expect(
      notifyMentions(['deniz'], { postId: 'p1', excerpt: 'selam @deniz' }),
    ).resolves.toBeUndefined()
  })
})
