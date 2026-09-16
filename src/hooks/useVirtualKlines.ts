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
    setIsLoading(true)
    setError(null)
    void listVirtualKlines(symbol, interval, limit)
      .then((data) => {
        if (!live) return
        if (data.length === 0) {
          setError('Sanal mum verisi bulunamadı.')
        } else {
          setKlines(data)
        }
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Sanal mumlar yüklenemedi.')
      })
      .finally(() => {
        if (live) setIsLoading(false)
      })
    return () => {
      live = false
    }
  }, [symbol, interval, limit])

  return { klines, isLoading, error }
}
