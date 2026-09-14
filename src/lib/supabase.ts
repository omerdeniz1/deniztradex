import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RAW_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

const BASE_URL = RAW_URL
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '')

/**
 * The Supabase client is only created outside vitest (`MODE === 'test'`) and
 * when both env vars are present. Tests keep running against the local
 * localStorage backend — deterministic and fully offline.
 */
export const isSupabaseConfigured =
  import.meta.env.MODE !== 'test' &&
  Boolean(BASE_URL) &&
  Boolean(ANON_KEY)

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(BASE_URL, ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null