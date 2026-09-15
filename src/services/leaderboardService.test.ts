import { describe, expect, it } from 'vitest'
import { getLeaderboard } from '@/services/leaderboardService'

describe('leaderboardService (offline — Supabase yok)', () => {
  it('rejects without backend instead of inventing a board', async () => {
    await expect(getLeaderboard()).rejects.toThrow()
  })
})
