import { useCallback, useEffect, useState } from 'react'
import { fetchUsdTryRate } from '@/services/rates'

export function useUsdTryRate() {
  const [rate, setRate] = useState<number>(NaN)
  const [live, setLive] = useState(false)

  const refresh = useCallback(() => {
    fetchUsdTryRate()
      .then((r) => {
        setRate(r)
        setLive(true)
      })
      .catch(() => {
        setLive(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { rate, live, refresh }
}