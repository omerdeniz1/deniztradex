import { describe, expect, it } from 'vitest'
import { resolveLivePrice } from '@/lib/utils'

describe('resolveLivePrice', () => {
  it('canlı soket varsa onu kullanır', () => {
    expect(resolveLivePrice('BTCUSDT', { BTCUSDT: 100 }, { BTCUSDT: { price: 90 } })).toBe(100)
  })

  it('soket yoksa ticker anlık görüntüsüne düşer (DNZ senaryosu)', () => {
    expect(resolveLivePrice('DNZUSDT', {}, { DNZUSDT: { price: 0.5 } })).toBe(0.5)
  })

  it('ikisi de yoksa 0 döner (bekçi emri atlar)', () => {
    expect(resolveLivePrice('DNZUSDT', {}, {})).toBe(0)
    expect(resolveLivePrice('DNZUSDT', { DNZUSDT: 0 }, { DNZUSDT: { price: 0 } })).toBe(0)
    expect(resolveLivePrice('X', {})).toBe(0)
  })
})
