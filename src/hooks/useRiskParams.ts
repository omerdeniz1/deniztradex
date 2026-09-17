import { useEffect, useState } from 'react'
import {
  DEFAULT_RISK_PARAMS,
  getRiskParams,
  type RiskParams,
} from '@/services/riskConfigService'
import { setMarkPriceWindow } from '@/engine/markPrice'

/**
 * Risk parametreleri hook'u: DB'deki `risk_config` satırını bir kez okur,
 * gelene kadar güvenli varsayılanlarla çalışır. Mark-price penceresini
 * motora işler (fitil koruması parametreyle senkron kalır).
 */
export function useRiskParams(): RiskParams {
  const [params, setParams] = useState<RiskParams>({ ...DEFAULT_RISK_PARAMS })

  useEffect(() => {
    let live = true
    void getRiskParams().then((p) => {
      if (!live) return
      setParams(p)
      setMarkPriceWindow(p.markPriceWindow)
    })
    return () => {
      live = false
    }
  }, [])

  return params
}
