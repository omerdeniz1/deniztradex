import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import { getSessionUser } from '@/services/authService'

/**
 * Etkinlikler (Events) — admin girer, herkes okur (`events` tablosu).
 *
 * Yetki sunucudadır (RLS + RPC `is_admin()` denetimi); istemcideki
 * süper-admin kontrolü yalnızca görünürlük kapısıdır. Çevrimdışı/test
 * modunda liste boş döner (sayfada "aktif etkinlik yok" görünür),
 * yazım hata fırlatır — sessiz fallback yoktur.
 */

export interface EventItem {
  id: string
  title: string
  body: string
  startsAt: number | null
  endsAt: number | null
  isActive: boolean
  createdAt: number
}

export const EVENT_TITLE_MAX = 120
export const EVENT_BODY_MAX = 2000

interface EventRow {
  id: unknown
  title: unknown
  body: unknown
  starts_at: unknown
  ends_at: unknown
  is_active: unknown
  created_at: unknown
}

function toEventItem(r: EventRow): EventItem | null {
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null
  const ts = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = Date.parse(String(v))
    return Number.isFinite(n) ? n : null
  }
  return {
    id: r.id,
    title: r.title.trim() || 'Etkinlik',
    body: typeof r.body === 'string' ? r.body : '',
    startsAt: ts(r.starts_at),
    endsAt: ts(r.ends_at),
    isActive: r.is_active === true,
    createdAt: Date.parse(String(r.created_at ?? '')) || 0,
  }
}

/** Herkese açık etkinlik listesi (önce aktifler, yeniden eskiye). */
export async function listEvents(limit = 20): Promise<EventItem[]> {
  if (!isSupabaseConfigured || !supabase) return []
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id,title,body,starts_at,ends_at,is_active,created_at')
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50))
    if (error || !Array.isArray(data)) return []
    return (data as EventRow[])
      .map(toEventItem)
      .filter((e): e is EventItem => e !== null)
  } catch {
    return []
  }
}

/** Yalnız aktif etkinlikler (vitrin sayacı/rozeti için). */
export async function listActiveEvents(limit = 20): Promise<EventItem[]> {
  const all = await listEvents(limit)
  return all.filter((e) => e.isActive)
}

async function requireSuperAdmin(): Promise<{ client: NonNullable<typeof supabase> }> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Etkinlik düzenleme çevrimdışı kullanılamaz. Bağlantını kontrol edip tekrar dene.')
  }
  const session = getSessionUser()
  if (!session) throw new Error('Oturum bulunamadı. Tekrar giriş yap.')
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', session.id)
    .maybeSingle()
  if (error || !data || (data as { is_admin?: unknown }).is_admin !== true) {
    throw new Error('Yalnızca süper admin etkinlik düzenleyebilir.')
  }
  return { client: supabase }
}

function toIsoOrNull(v: string): string | null {
  const t = v.trim()
  if (!t) return null
  const n = Date.parse(t)
  if (!Number.isFinite(n)) throw new Error('Geçersiz tarih. (örn. 2026-10-01 18:00)')
  return new Date(n).toISOString()
}

export interface EventInput {
  title: string
  body: string
  /** `datetime-local` değeri ya da boş. */
  startsAt: string
  endsAt: string
  isActive: boolean
}

function validateEventInput(input: EventInput): {
  title: string
  body: string
  startsAt: string | null
  endsAt: string | null
} {
  const title = input.title.trim()
  const body = input.body.trim()
  if (!title) throw new Error('Etkinlik başlığı gerekli.')
  if (!body) throw new Error('Etkinlik metni gerekli.')
  if (title.length > EVENT_TITLE_MAX) {
    throw new Error(`Başlık en fazla ${EVENT_TITLE_MAX} karakter olabilir.`)
  }
  if (body.length > EVENT_BODY_MAX) {
    throw new Error(`Metin en fazla ${EVENT_BODY_MAX} karakter olabilir.`)
  }
  const startsAt = toIsoOrNull(input.startsAt)
  const endsAt = toIsoOrNull(input.endsAt)
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new Error('Bitiş tarihi başlangıçtan sonra olmalı.')
  }
  return { title, body, startsAt, endsAt }
}

/** Yeni etkinlik (yalnızca süper admin). Düzenleme için id ile çağrılır. */
export async function saveEvent(id: string | null, input: EventInput): Promise<string> {
  const clean = validateEventInput(input)
  const { client } = await requireSuperAdmin()
  const { data, error } = await client.rpc('upsert_event', {
    p_id: id,
    p_title: clean.title,
    p_body: clean.body,
    p_starts_at: clean.startsAt,
    p_ends_at: clean.endsAt,
    p_is_active: input.isActive,
  })
  if (error) {
    const detail = String((error as { message?: unknown })?.message ?? '').trim()
    throw new Error(detail ? `Etkinlik kaydedilemedi: ${detail}` : 'Etkinlik kaydedilemedi. Lütfen tekrar dene.')
  }
  const newId = (data as { id?: unknown } | null)?.id
  if (typeof newId !== 'string' || !newId) throw new Error('Etkinlik kaydedilemedi. Lütfen tekrar dene.')
  return newId
}

/** Etkinlik sil (yalnızca süper admin). */
export async function deleteEvent(id: string): Promise<void> {
  if (!id) throw new Error('Etkinlik bulunamadı.')
  const { client } = await requireSuperAdmin()
  const { error } = await client.rpc('delete_event', { p_id: id })
  if (error) throw new Error('Etkinlik silinemedi. Lütfen tekrar dene.')
}
