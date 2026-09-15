import { beforeEach, describe, expect, it } from 'vitest'
import {
  createForumPost,
  deleteForumPost,
  formatTimeAgo,
  listForumPosts,
  toggleForumLike,
} from '@/services/forumService'
import type { User } from '@/types'

const alice: User = { id: 'u_alice', username: 'alice', email: 'a@x.com', createdAt: 1 }
const bob: User = { id: 'u_bob', username: 'bob', email: 'b@x.com', createdAt: 1 }

function loginAs(user: User | null) {
  if (user) localStorage.setItem('deniztradx_session', JSON.stringify(user))
  else localStorage.removeItem('deniztradx_session')
}

beforeEach(() => {
  localStorage.clear()
})

describe('forumService (offline backend)', () => {
  it('rejects empty and overlong posts', async () => {
    loginAs(alice)
    await expect(createForumPost('   ')).rejects.toThrow('boş')
    await expect(createForumPost('x'.repeat(281))).rejects.toThrow('280')
  })

  it('creates posts newest-first (after the welcome seed)', async () => {
    loginAs(alice)
    const post = await createForumPost('Merhaba forum!')
    expect(post.content).toBe('Merhaba forum!')
    expect(post.likeCount).toBe(0)
    const list = await listForumPosts()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(post.id)
  })

  it('toggles likes per user without double counting', async () => {
    loginAs(alice)
    const post = await createForumPost('Beğeni testi')
    loginAs(bob)
    await expect(toggleForumLike(post.id)).resolves.toMatchObject({ liked: true, likeCount: 1 })
    await expect(toggleForumLike(post.id)).resolves.toMatchObject({ liked: false, likeCount: 0 })
    const list = await listForumPosts()
    expect(list.find((p) => p.id === post.id)?.likedByMe).toBe(false)
  })

  it('deletes own posts but not others', async () => {
    loginAs(alice)
    const post = await createForumPost('Silinecek')
    loginAs(bob)
    await expect(deleteForumPost(post.id)).rejects.toThrow('kendi gönderini')
    loginAs(alice)
    await deleteForumPost(post.id)
    const list = await listForumPosts()
    expect(list.some((p) => p.id === post.id)).toBe(false)
  })
})

describe('formatTimeAgo', () => {
  it('formats tr-TR relative times', () => {
    const now = Date.now()
    expect(formatTimeAgo(now)).toBe('az önce')
    expect(formatTimeAgo(now - 5 * 60_000)).toBe('5d')
    expect(formatTimeAgo(now - 3 * 3_600_000)).toBe('3sa')
    expect(formatTimeAgo(now - 2 * 86_400_000)).toBe('2g')
  })
})
