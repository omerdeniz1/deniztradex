import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUserId } from '@/services/authService'

/**
 * Forum profilleri (Twitter tarzı): herkese açık kart + takipçi sistemi.
 *
 * - Profil tek çağrıda gelir (`get_public_profile` RPC): ad, bio, avatar,
 *   rozet, takipçi/takip edilen/gönderi sayıları + `is_following`.
 * - Takipçi sayısı = TABAN + gerçek takipler. Taban (persona 1.7M/800B/780B
 *   veya `profiles.follower_base`) sabittir — gerçek biri takip edince de
 *   bırakınca da taban DÜŞMEZ, sayı yalnızca üstüne eklenir/eksilir.
 * - Beğeni tabanı aynı mantıkla `forum_posts.base_likes`'tadır (sunucu
 *   sayacı taban + gerçek yazar) — persona gönderileri 10-20 binle başlar,
 *   gerçek beğeni sıfırlamaz.
 * - Personalar auth satırı olmadan yaşar (`persona_profiles`); çevrimdışı/
 *   testte aynı 3 hesap statik yedekten gelir.
 */

export type VerifiedTier = 'none' | 'admin' | 'super'

export interface PersonaSeed {
  username: string
  displayName: string
  bio: string
  followerBase: number
  verifiedTier: VerifiedTier
}

/** Senaryo hesapları (migration seed'iyle birebir aynı olmalı). */
export const PERSONAS: PersonaSeed[] = [
  {
    username: 'DenizTradeXx',
    displayName: 'DenizTradeX',
    bio: 'DenizTradeX resmi hesabı — duyurular, listelemeler ve piyasa notları buradan paylaşılır.',
    followerBase: 1700000,
    verifiedTier: 'super',
  },
  {
    username: 'omerbabaparayapmakta',
    displayName: 'Ömer Baba',
    bio: 'Kripto analisti — piyasa yapısı, likidite haritaları ve döngü notları. Yatırım tavsiyesi değildir.',
    followerBase: 800000,
    verifiedTier: 'admin',
  },
  {
    username: 'blackrock',
    displayName: 'BlackRock',
    bio: 'Kurumsal kripto masası parodisi — ETF akımları, makro ve risk iştahı notları. Yatırım tavsiyesi değildir.',
    followerBase: 780000,
    verifiedTier: 'admin',
  },
]

export function findPersona(username: string): PersonaSeed | null {
  const key = username.trim().toLowerCase()
  if (!key) return null
  return PERSONAS.find((p) => p.username.toLowerCase() === key) ?? null
}

export interface PublicProfile {
  username: string
  handle: string
  bio: string
  avatarUrl: string | null
  verifiedTier: VerifiedTier
  createdAt: number
  followers: number
  following: number
  posts: number
  isFollowing: boolean
  isPersona: boolean
}

function parseTier(v: unknown): VerifiedTier {
  return v === 'super' || v === 'admin' ? v : 'none'
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 1700000 → "1,7 Mn" · 25300 → "25,3 B" · 950 → "950" (tr-TR). */
export function formatFollowCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${v.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} Mn`
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return `${v.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} B`
  }
  return Math.floor(n).toLocaleString('tr-TR')
}

function personaProfile(seed: PersonaSeed): PublicProfile {
  return {
    username: seed.displayName,
    handle: seed.username.toLowerCase(),
    bio: seed.bio,
    avatarUrl: null,
    verifiedTier: seed.verifiedTier,
    createdAt: 0,
    followers: seed.followerBase,
    following: 0,
    posts: 0,
    isFollowing: false,
    isPersona: true,
  }
}

function mapRpcProfile(r: Record<string, unknown>): PublicProfile {
  return {
    username: text(r.username) || text(r.handle),
    handle: text(r.handle).toLowerCase(),
    bio: text(r.bio),
    avatarUrl: typeof r.avatar_url === 'string' && r.avatar_url ? r.avatar_url : null,
    verifiedTier: parseTier(r.verified_tier),
    createdAt: Date.parse(String(r.created_at ?? '')) || 0,
    followers: num(r.followers),
    following: num(r.following),
    posts: num(r.posts),
    isFollowing: r.is_following === true,
    isPersona: r.is_persona === true,
  }
}

/** Herkese açık profil kartı (girişsiz de çalışır). Yoksa null. */
export async function getPublicProfile(username: string): Promise<PublicProfile | null> {
  const needle = username.trim()
  if (!needle) return null
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.rpc('get_public_profile', {
        p_username: needle,
      })
      if (!error && data) {
        const r = data as Record<string, unknown>
        if (r && r.ok === true) return mapRpcProfile(r)
        return null
      }
    } catch {
      // eski DB — persona yedeğine düş
    }
  }
  const seed = findPersona(needle)
  return seed ? personaProfile(seed) : null
}

/** Takip et (giriş gerekir). Güncel takipçi sayısını döndürür. */
export async function followUser(username: string): Promise<number> {
  const userId = getSessionUserId()
  if (!userId) throw new Error('Takip için giriş yapmalısın.')
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('follow_user', { p_username: username.trim() })
    if (error) throw new Error(mapFollowError(error))
    if (data && typeof data === 'object') {
      const profile = await getPublicProfile(username).catch(() => null)
      if (profile) return profile.followers
    }
    const seed = findPersona(username)
    return seed ? seed.followerBase + 1 : 1
  }
  const seed = findPersona(username)
  if (seed) return seed.followerBase + 1
  throw new Error('Çevrimdışı modda takip edilemez.')
}

/** Takibi bırak (giriş gerekir). Güncel takipçi sayısını döndürür. */
export async function unfollowUser(username: string): Promise<number> {
  const userId = getSessionUserId()
  if (!userId) throw new Error('Takip için giriş yapmalısın.')
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('unfollow_user', { p_username: username.trim() })
    void data
    if (error) throw new Error(mapFollowError(error))
    const profile = await getPublicProfile(username).catch(() => null)
    if (profile) return profile.followers
    const seed = findPersona(username)
    return seed ? seed.followerBase : 0
  }
  const seed = findPersona(username)
  if (seed) return seed.followerBase
  throw new Error('Çevrimdışı modda takip edilemez.')
}

/** Kendi tanıtım yazını günceller (220 karakter). */
export async function updateMyBio(bio: string): Promise<void> {
  const userId = getSessionUserId()
  if (!userId) throw new Error('Giriş yapmalısın.')
  const clean = bio.trim().slice(0, 220)
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.from('profiles').update({ bio: clean }).eq('id', userId)
    if (error) throw new Error('Tanıtım yazısı kaydedilemedi.')
    return
  }
  // Çevrimdışı modda yazım yok — sessiz geç.
}

function mapFollowError(error: unknown): string {
  const msg = String((error as { message?: unknown })?.message ?? '')
  if (msg.includes('kendini takip')) return 'Kendini takip edemezsin.'
  if (msg.includes('giriş gerekli')) return 'Takip için giriş yapmalısın.'
  return msg || 'İşlem yapılamadı.'
}
