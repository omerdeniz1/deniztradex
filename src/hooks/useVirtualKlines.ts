import { useEffect, useState } from 'react'
import { listVirtualKlines } from '@/services/virtualMarketService'
import type { Interval, Kline } from '@/types'

/**
 * Sanal coin mumları: `virtual_kline_data` tablosundan (çevrimdışında
 * sentetik üretilir). Sembol boşsa boş-geri-dönüş (koşulsuz çağrılabilir).
 */
export function useVirtualKlines(symbol: string, interval: Interval, limit = 300) {
  const [klines, setKlines] = useState<Kline[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (!symbol) {
      setKlines([])
      setIsLoading(false)
      setError(null)
      return () => {
        live = false
      }
    }
    const fetchQuiet = (loud: boolean) => {
      if (loud) {
        setIsLoading(true)
        setError(null)
      }
      void listVirtualKlines(symbol, interval, limit)
        .then((data) => {
          if (!live) return
          if (data.length === 0) {
            if (loud) setError('Sanal mum verisi bulunamadı.')
          } else {
            setKlines(data)
          }
        })
        .catch((err: unknown) => {
          if (live && loud) setError(err instanceof Error ? err.message : 'Sanal mumlar yüklenemedi.')
        })
        .finally(() => {
          if (live && loud) setIsLoading(false)
        })
    }
    // Bot hamleleri grafiğe düşsün diye sessiz yoklama (15 sn).
    fetchQuiet(true)
    const timer = window.setInterval(() => fetchQuiet(false), 15000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [symbol, interval, limit])

  return { klines, isLoading, error }
}
