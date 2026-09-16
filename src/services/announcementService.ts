import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'

/**
 * Sistem duyuruları — süper admin yayınlar, tüm giriş yapmış
 * kullanıcılar okur (`announcements` tablosu).
 *
 * Yetki sunucudadır (RLS: okuma herkese, yazma `is_admin()`); istemci
 * tarafındaki süper-admin kontrolü yalnızca görünürlük kapısıdır.
 * Çevrimdışı/test modunda liste boş döner (banner gizlenir), yazım
 * hata fırlatır — sessiz fallback yoktur.
 */

export interface Announcement {
  id: string
  title: string
  body: string
  createdAt: number
}

export const ANNOUNCEMENT_TITLE_MAX = 120
export const ANNOUNCEMENT_BODY_MAX = 1000

/**
 * Duyuru bandı görünürlük penceresi: duyuru ilk görüldükten sonra çıkış
 * + girişlerde 1 saat boyunca tekrar gösterilir, süre dolunca bir daha
 * gösterilmez.
 */
export const ANNOUNCEMENT_BANNER_VISIBILITY_MS = 60 * 60 * 1000

export function isAnnouncementVisible(
  firstSeenMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (firstSeenMs == null || !Number.isFinite(firstSeenMs)) return true
  return nowMs - firstSeenMs < ANNOUNCEMENT_BANNER_VISIBILITY_MS
}

interface AnnouncementRow {
  id: unknown
  title: unknown
  body: unknown
  created_at: unknown
}

/** En güncel duyurular (yeniden eskiye). Çevrimdışıyken boş liste. */
export async function listAnnouncements(limit = 5): Promise<Announcement[]> {
  if (!isSupabaseConfigured || !supabase) return []
  try {
    const { data, error } = await supabase
      .from('announcements')
      .select('id,title,body,created_at')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 20))
    if (error || !Array.isArray(data)) return []
    return (data as AnnouncementRow[])
      .filter((r) => typeof r.id === 'string' && typeof r.title === 'string')
      .map((r) => ({
        id: r.id as string,
        title: (r.title as string).trim() || 'Duyuru',
        body: typeof r.body === 'string' ? r.body : '',
        createdAt: Date.parse(String(r.created_at ?? '')) || 0,
      }))
  } catch {
    return []
  }
}

export type AnnouncementsSetupStatus = 'ok' | 'missing-table' | 'offline' | 'denied' | 'error'

/** Duyuru altyapısı hazır mı? (tablo yoksa migration uygulanmamış demektir) */
export async function getAnnouncementsStatus(): Promise<AnnouncementsSetupStatus> {
  if (!isSupabaseConfigured || !supabase) return 'offline'
  try {
    const { error } = await supabase.from('announcements').select('id').limit(1)
    if (!error) return 'ok'
    return classifyDbError(error)
  } catch {
    return 'error'
  }
}

function classifyDbError(error: unknown): 'missing-table' | 'denied' | 'error' {
  const code = (error as { code?: unknown })?.code
  const msg = String((error as { message?: unknown })?.message ?? '').toLowerCase()
  if (code === '42P01' || msg.includes('does not exist') || msg.includes('could not find the table')) {
    return 'missing-table'
  }
  if (code === '42501' || msg.includes('policy') || msg.includes('permission denied')) {
    return 'denied'
  }
  return 'error'
}

function publishErrorMessage(error: unknown): string {
  const kind = classifyDbError(error)
  if (kind === 'missing-table') {
    return 'Duyuru tablosu veritabanında yok. Supabase SQL editöründe 20260916110000_announcements migration’ını uygulayın.'
  }
  if (kind === 'denied') {
    return 'Yetki reddedildi: yalnızca süper admin yayınlayabilir.'
  }
  const detail = String((error as { message?: unknown })?.message ?? '').trim()
  return detail ? `Duyuru yayınlanamadı: ${detail}` : 'Duyuru yayınlanamadı. Lütfen tekrar dene.'
}

function validateAnnouncementInput(title: string, body: string): { title: string; body: string } {
  const t = title.trim()
  const b = body.trim()
  if (!t) throw new Error('Duyuru başlığı gerekli.')
  if (!b) throw new Error('Duyuru metni gerekli.')
  if (t.length > ANNOUNCEMENT_TITLE_MAX) {
    throw new Error(`Başlık en fazla ${ANNOUNCEMENT_TITLE_MAX} karakter olabilir.`)
  }
  if (b.length > ANNOUNCEMENT_BODY_MAX) {
    throw new Error(`Metin en fazla ${ANNOUNCEMENT_BODY_MAX} karakter olabilir.`)
  }
  return { title: t, body: b }
}

async function requireSuperAdmin(): Promise<{ client: NonNullable<typeof supabase>; userId: string }> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Duyuru yayını çevrimdışı kullanılamaz. Bağlantını kontrol edip tekrar dene.')
  }
  const session = getSessionUser()
  if (!session) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', session.id)
    .maybeSingle()
  if (error || !data || (data as { is_admin?: unknown }).is_admin !== true) {
    throw new Error('Yalnızca süper admin duyuru yayınlayabilir.')
  }
  return { client: supabase, userId: session.id }
}

/** Yeni sistem duyurusu yayınla (yalnızca süper admin). */
export async function createAnnouncement(title: string, body: string): Promise<Announcement> {
  const clean = validateAnnouncementInput(title, body)
  const { client, userId } = await requireSuperAdmin()
  const { data, error } = await client
    .from('announcements')
    .insert({ title: clean.title, body: clean.body, created_by: userId })
    .select('id,title,body,created_at')
    .maybeSingle()
  if (error || !data) {
    throw new Error(publishErrorMessage(error))
  }
  const row = data as AnnouncementRow
  return {
    id: String(row.id ?? ''),
    title: clean.title,
    body: clean.body,
    createdAt: Date.parse(String(row.created_at ?? '')) || Date.now(),
  }
}

/** Duyuruyu sil (yalnızca süper admin). */
export async function deleteAnnouncement(id: string): Promise<void> {
  if (!id) throw new Error('Duyuru bulunamadı.')
  const { client } = await requireSuperAdmin()
  const { error } = await client.from('announcements').delete().eq('id', id)
  if (error) {
    throw new Error(
      classifyDbError(error) === 'missing-table'
        ? 'Duyuru tablosu veritabanında yok. Supabase SQL editöründe 20260916110000_announcements migration’ını uygulayın.'
        : 'Duyuru silinemedi. Lütfen tekrar dene.',
    )
  }
}
