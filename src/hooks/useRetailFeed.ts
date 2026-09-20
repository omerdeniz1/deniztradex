import { useEffect, useState } from 'react'
import { onRetailTrade, type RetailPrint } from '@/services/retailBotService'

/**
 * Perakende bot bant akışı: son baskılar (yeniden eskiye). Botun
 * ürettiği her alım/satım buraya ANINDA düşer — grafikler mevcut
 * yoklama döngüleriyle (sanal mumlar ~15 sn) tazelenir.
 */
export function useRetailFeed(limit = 20): RetailPrint[] {
  const [prints, setPrints] = useState<RetailPrint[]>([])
  useEffect(() => {
    const clean = Math.min(Math.max(Math.floor(limit) || 20, 1), 100)
    return onRetailTrade((p) => {
      setPrints((prev) => [p, ...prev].slice(0, clean))
    })
  }, [limit])
  return prints
}
