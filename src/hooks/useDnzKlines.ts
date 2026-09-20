import { useEffect, useState } from 'react'
import { DNZ_PAIR, getDnzKlines } from '@/services/dnzService'
import type { Interval, Kline } from '@/types'

/**
 * DNZ mumları: deterministik yürüyüşten senkron üretilir (sunucu yok).
 * Sembol boşsa / DNZ değilse boş-geri-dönüş (koşulsuz çağrılabilir).
 */
export function useDnzKlines(symbol: string, interval: Interval, limit = 300) {
  const [klines, setKlines] = useState<Kline[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (symbol.toUpperCase() !== DNZ_PAIR) {
      setKlines([])
      setIsLoading(false)
      setError(null)
      return () => {
        live = false
      }
    }
    const compute = (loud: boolean) => {
      if (loud) {
        setIsLoading(true)
        setError(null)
      }
      try {
        const data = getDnzKlines(interval, Date.now(), limit)
        if (!live) return
        if (data.length === 0) {
          if (loud) setError('DNZ mum verisi bulunamadı.')
        } else {
          setKlines(data)
        }
      } catch (err: unknown) {
        if (live && loud) setError(err instanceof Error ? err.message : 'DNZ mumları yüklenemedi.')
      } finally {
        if (live && loud) setIsLoading(false)
      }
    }
    // Adım 5 dk'da bir ilerler — sessiz yoklama (30 sn) forming mumu tazeler.
    compute(true)
    const timer = window.setInterval(() => compute(false), 30000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [symbol, interval, limit])

  return { klines, isLoading, error }
}
