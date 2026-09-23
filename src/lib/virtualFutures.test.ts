import { describe, expect, it } from 'vitest'
import { MAX_LEVERAGE } from '@/engine/calculations'
import { VIRTUAL_SEED } from '@/services/virtualMarketService'
import {
  clampFuturesLeverage,
  isVirtualFuturesSymbol,
  maxLeverageFor,
  VIRTUAL_FUTURES_SYMBOLS,
  VIRTUAL_MAX_LEVERAGE,
} from '@/lib/virtualFutures'

describe('virtualFutures', () => {
  it('sembol kümesi VIRTUAL_SEED ile birebir eşleşir', () => {
    expect(new Set(VIRTUAL_FUTURES_SYMBOLS)).toEqual(
      new Set(VIRTUAL_SEED.map((s) => s.symbol.toUpperCase())),
    )
  })

  it('sanal sembolleri tanır (case-insensitive, DNZ dahil)', () => {
    expect(isVirtualFuturesSymbol('ENTES')).toBe(true)
    expect(isVirtualFuturesSymbol('dnz')).toBe(true)
    expect(isVirtualFuturesSymbol('v-xau')).toBe(true)
    expect(isVirtualFuturesSymbol('BTCUSDT')).toBe(false)
    expect(isVirtualFuturesSymbol('BTC')).toBe(false)
    expect(isVirtualFuturesSymbol('')).toBe(false)
  })

  it('sanalda tavan 20x, gerçekte 125x', () => {
    expect(VIRTUAL_MAX_LEVERAGE).toBe(20)
    expect(maxLeverageFor('ENTES')).toBe(20)
    expect(maxLeverageFor('DNZ')).toBe(20)
    expect(maxLeverageFor('BTCUSDT')).toBe(MAX_LEVERAGE)
  })

  it('kaldıraç kelepçesi sembole göre çalışır', () => {
    expect(clampFuturesLeverage('ENTES', 125)).toBe(20)
    expect(clampFuturesLeverage('ENTES', 10)).toBe(10)
    expect(clampFuturesLeverage('BTCUSDT', 125)).toBe(125)
    expect(clampFuturesLeverage('ENTES', 0)).toBe(1)
    expect(clampFuturesLeverage('ENTES', NaN)).toBe(1)
  })
})
