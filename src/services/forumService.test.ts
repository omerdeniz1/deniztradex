import { beforeEach, describe, expect, it } from 'vitest'
import {
  classifyForumRemoteError,
  createForumPost,
  createForumReply,
  deleteForumPost,
  deleteForumReply,
  formatTimeAgo,
  forumDisplayName,
  isVerifiedUsername,
  listForumPosts,
  listForumReplies,
  parseVerifiedTier,
  toggleForumLike,
  toggleForumReplyLike,
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
    await expect(createForumPost('x'.repeat(501))).rejects.toThrow('500')
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

  it('stores user tag and image url on posts and replies', async () => {
    loginAs({ ...alice, userTag: 'Balina' })
    const post = await createForumPost('Fotoğraflı gönderi', { imageUrl: 'https://img/x.jpg' })
    expect(post).toMatchObject({ userTag: 'Balina', imageUrl: 'https://img/x.jpg' })
    const reply = await createForumReply(post.id, 'güzel foto', { imageUrl: 'https://img/y.png' })
    expect(reply).toMatchObject({ userTag: 'Balina', imageUrl: 'https://img/y.png' })
    const list = await listForumPosts()
    expect(list.find((p) => p.id === post.id)).toMatchObject({
      userTag: 'Balina',
      imageUrl: 'https://img/x.jpg',
    })
    const replies = await listForumReplies(post.id)
    expect(replies[0]).toMatchObject({ userTag: 'Balina', imageUrl: 'https://img/y.png' })
  })

  it('legacy local rows without tag/image normalize to null', async () => {
    loginAs(alice)
    localStorage.setItem(
      'deniztradx_forum_posts_v1',
      JSON.stringify([
        { id: 'legacy1', userId: 'u_alice', username: 'alice', content: 'eski', likedBy: [], replies: [], createdAt: 1 },
      ]),
    )
    const list = await listForumPosts()
    expect(list.find((p) => p.id === 'legacy1')).toMatchObject({ userTag: null, imageUrl: null })
  })
})

describe('forum replies (offline backend)', () => {  it('rejects empty and overlong replies', async () => {
    loginAs(alice)
    const post = await createForumPost('Yanıtlanacak')
    await expect(createForumReply(post.id, '   ')).rejects.toThrow('boş')
    await expect(createForumReply(post.id, 'x'.repeat(501))).rejects.toThrow('500')
  })

  it('creates, lists oldest-first and counts replies', async () => {
    loginAs(alice)
    const post = await createForumPost('Ana gönderi')
    loginAs(bob)
    await createForumReply(post.id, 'ilk yanıt')
    await createForumReply(post.id, 'ikinci yanıt')
    const replies = await listForumReplies(post.id)
    expect(replies).toHaveLength(2)
    expect(replies[0].content).toBe('ilk yanıt')
    expect(replies[1].username).toBe('bob')
    const list = await listForumPosts()
    expect(list.find((p) => p.id === post.id)?.replyCount).toBe(2)
  })

  it('deletes own replies but not others', async () => {
    loginAs(alice)
    const post = await createForumPost('Ana gönderi')
    const reply = await createForumReply(post.id, 'alice yanıtı')
    loginAs(bob)
    await expect(deleteForumReply(post.id, reply.id)).rejects.toThrow('kendi yanıtını')
    loginAs(alice)
    await deleteForumReply(post.id, reply.id)
    expect(await listForumReplies(post.id)).toHaveLength(0)
  })

  it('toggles reply likes per user without double counting', async () => {
    loginAs(alice)
    const post = await createForumPost('Beğenili yanıt ana gönderisi')
    const reply = await createForumReply(post.id, 'beğen beni')
    loginAs(bob)
    await expect(toggleForumReplyLike(post.id, reply.id)).resolves.toMatchObject({
      liked: true,
      likeCount: 1,
    })
    await expect(toggleForumReplyLike(post.id, reply.id)).resolves.toMatchObject({
      liked: false,
      likeCount: 0,
    })
    const replies = await listForumReplies(post.id)
    expect(replies[0]).toMatchObject({ likeCount: 0, likedByMe: false })
    loginAs(alice)
    await toggleForumReplyLike(post.id, reply.id)
    const after = await listForumReplies(post.id)
    expect(after[0]).toMatchObject({ likeCount: 1, likedByMe: true })
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

describe('forum legacy local data', () => {
  it('normalizes pre-replies posts instead of crashing the feed', async () => {
    loginAs(alice)
    // Yanıt özelliğinden önce yazılmış kayıt: `replies`/`likedBy` yok.
    localStorage.setItem(
      'deniztradx_forum_posts_v1',
      JSON.stringify([
        { id: 'old_1', userId: 'u_alice', username: 'alice', content: 'eski gönderi', createdAt: 123 },
      ]),
    )
    const list = await listForumPosts()
    expect(list.find((p) => p.id === 'old_1')).toMatchObject({ replyCount: 0, likeCount: 0 })
    // Üstüne yanıt da verilebilmeli.
    const reply = await createForumReply('old_1', 'yeni yanıt')
    expect(reply.content).toBe('yeni yanıt')
    expect(await listForumReplies('old_1')).toHaveLength(1)
  })
})

describe('forumDisplayName', () => {
  it('never shows a raw uid/uuid in the UI', () => {
    expect(forumDisplayName('alice', 'u_alice')).toBe('alice')
    expect(forumDisplayName('b47a515e-6c25-4daa-a683-34a8fc1eb8e5', 'b47a515e-6c25-4daa-a683-34a8fc1eb8e5')).toBe(
      'Kullanıcı',
    )
    expect(forumDisplayName('', 'u_bob')).toBe('u_bob')
  })
})

describe('forum verified badge', () => {
  it('marks the DenizTradeX system account as verified', () => {
    expect(isVerifiedUsername('DenizTradeX')).toBe(true)
    expect(isVerifiedUsername('deniztradex')).toBe(true)
    expect(isVerifiedUsername('alice')).toBe(false)
    expect(isVerifiedUsername('')).toBe(false)
  })

  it('flags the local welcome seed as verified, normal posts as not', async () => {
    loginAs(alice)
    const list = await listForumPosts()
    expect(list.find((p) => p.id === 'seed_welcome')).toMatchObject({ verifiedTier: 'super', avatarUrl: null })
    const post = await createForumPost('sıradan gönderi')
    expect(post.verifiedTier).toBe('none')
    expect(post.avatarUrl).toBeNull()
  })

  it('parses remote tiers safely', () => {
    expect(parseVerifiedTier('super')).toBe('super')
    expect(parseVerifiedTier('admin')).toBe('admin')
    expect(parseVerifiedTier('none')).toBe('none')
    expect(parseVerifiedTier(true)).toBe('none')
    expect(parseVerifiedTier('gold')).toBe('none')
    expect(parseVerifiedTier(undefined)).toBe('none')
  })
})

describe('classifyForumRemoteError', () => {
  it('detects missing tables (setup) instead of blaming the connection', () => {
    const err = classifyForumRemoteError(
      { code: 'PGRST205', message: "Could not find the table 'public.forum_posts' in the schema cache" },
      'Gönderi paylaşılamadı',
    )
    expect(err.message).toMatch('kurulum eksik')
    expect(err.message).toMatch('APPLY_ALL_PENDING.sql')
  })

  it('detects missing RPC functions', () => {
    const err = classifyForumRemoteError(
      { code: 'PGRST202', message: 'Could not find the function public.toggle_forum_like' },
      'Beğeni işlenemedi',
    )
    expect(err.message).toMatch('kurulum eksik')
  })

  it('detects RLS/session problems', () => {
    const err = classifyForumRemoteError(
      { code: '42501', message: 'new row violates row-level security policy' },
      'Gönderi paylaşılamadı',
    )
    expect(err.message).toMatch('tekrar giriş yap')
  })

  it('detects network failures', () => {
    const err = classifyForumRemoteError(new TypeError('Failed to fetch'), 'Akış yüklenemedi')
    expect(err.message).toMatch('bağlantı')
  })

  it('falls back to a generic message without leaking internals', () => {
    const err = classifyForumRemoteError(new Error('unexpected-feed-shape'), 'Akış yüklenemedi')
    expect(err.message).toBe('Akış yüklenemedi. Lütfen tekrar dene.')
  })
})
