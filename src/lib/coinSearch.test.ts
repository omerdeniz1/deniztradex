import { describe, expect, it } from 'vitest'
import { baseOf, matchPairQuery } from '@/lib/coinSearch'

describe('matchPairQuery', () => {
  it('matches the ticker case-insensitively', () => {
    expect(matchPairQuery('BTCUSDT', 'btc')).toBe(true)
    expect(matchPairQuery('BTCUSDT', 'BTC')).toBe(true)
    expect(matchPairQuery('SOLUSDT', 'sol')).toBe(true)
    expect(matchPairQuery('PEPEUSDT', 'pepe')).toBe(true)
  })

  it('matches common names like ether, bitcoin and solana', () => {
    expect(matchPairQuery('ETHUSDT', 'ether')).toBe(true)
    expect(matchPairQuery('ETHUSDT', 'ethereum')).toBe(true)
    expect(matchPairQuery('BTCUSDT', 'bitcoin')).toBe(true)
    expect(matchPairQuery('SOLUSDT', 'solana')).toBe(true)
    expect(matchPairQuery('DOGEUSDT', 'dogecoin')).toBe(true)
    expect(matchPairQuery('XRPUSDT', 'ripple')).toBe(true)
  })

  it('does not match unrelated symbols', () => {
    expect(matchPairQuery('ETHUSDT', 'sol')).toBe(false)
    expect(matchPairQuery('BTCUSDT', 'ada')).toBe(false)
  })

  it('matches virtual commodities by Turkish names', () => {
    expect(matchPairQuery('V-XAU', 'altın')).toBe(true)
    expect(matchPairQuery('V-XAU', 'altin')).toBe(true)
    expect(matchPairQuery('V-XAG', 'gümüş')).toBe(true)
    expect(matchPairQuery('V-XAG', 'gumus')).toBe(true)
    expect(matchPairQuery('ENTES', 'entes')).toBe(true)
    expect(matchPairQuery('BTCUSDT', 'altın')).toBe(false)
  })

  it('matches everything on an empty query', () => {
    expect(matchPairQuery('BTCUSDT', '')).toBe(true)
    expect(matchPairQuery('XRPUSDT', '   ')).toBe(true)
  })
})

describe('baseOf', () => {
  it('strips the USDT suffix', () => {
    expect(baseOf('BTCUSDT')).toBe('BTC')
    expect(baseOf('PEPEUSDT')).toBe('PEPE')
  })
})