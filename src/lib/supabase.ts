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

/**
 * Safari dayanıklılığı: gizli mod / ITP kısıtlarında `localStorage`
 * erişimi patlayabilir. Supabase'e verilen bu sarmalayıcı, yazım
 * başarısız olursa belleğe düşer — oturum sekme açıkken yaşar,
 * uygulama asla localStorage hatasıyla kilitlenmez.
 */
function createSafeStorage(): Storage {
  const memory = new Map<string, string>()
  const probe = (fn: () => string | null): string | null => {
    try {
      return fn()
    } catch {
      return null
    }
  }
  return {
    get length(): number {
      try {
        return localStorage.length
      } catch {
        return memory.size
      }
    },
    clear(): void {
      try {
        localStorage.clear()
      } catch {
        memory.clear()
      }
    },
    getItem(key: string): string | null {
      const fromLs = probe(() => localStorage.getItem(key))
      if (fromLs !== null) return fromLs
      return memory.get(key) ?? null
    },
    key(index: number): string | null {
      try {
        return localStorage.key(index)
      } catch {
        return Array.from(memory.keys())[index] ?? null
      }
    },
    removeItem(key: string): void {
      memory.delete(key)
      try {
        localStorage.removeItem(key)
      } catch {
        // yoksay — bellek kopyası zaten silindi
      }
    },
    setItem(key: string, value: string): void {
      memory.set(key, value)
      try {
        localStorage.setItem(key, value)
      } catch {
        // kota/gizli mod — bellek kopyası yeterli
      }
    },
  }
}

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(BASE_URL, ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // PKCE, mobil Safari / ITP altında implicit flow'dan daha güvenli
        // ve URL parçası sorunlarına takılmaz.
        flowType: 'pkce',
        storage: createSafeStorage(),
      },
    })
  : null