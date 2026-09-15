import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/store/settingsStore'

/**
 * Tailwind `md` kırılımıyla aynı sınır: 768px altı mobil sayılır.
 * Masaüstü görünüm asla etkilenmez.
 */
const MOBILE_QUERY = '(max-width: 767px)'

function readIsMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  try {
    return window.matchMedia(MOBILE_QUERY).matches
  } catch {
    return false
  }
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobile)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return isMobile
}

/**
 * Efektif tema: mobilde HER ZAMAN açık tema (temiz/ferah görünüm),
 * masaüstünde kullanıcının ayarı. Grafik paleti dahil tüm tema
 * tüketicileri bunu kullanmalı ki mobilde grafik de beyaz olsun.
 */
export function useEffectiveTheme(): 'dark' | 'light' {
  const theme = useSettingsStore((s) => s.theme)
  const isMobile = useIsMobile()
  return isMobile ? 'light' : theme
}
