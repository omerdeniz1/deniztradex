import { beforeEach, describe, expect, it } from 'vitest'
import { useTradeStore } from '@/store/tradeStore'
import type { OrderInput } from '@/engine/calculations'

function makeOrder(o: Partial<OrderInput> = {}): OrderInput {
  return {
    symbol: 'BTCUSDT',
    side: 'long',
    mode: 'spot',
    quantity: 1,
    entryPrice: 100,
    leverage: 1,
    ...o,
  }
}

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
})

describe('deposit', () => {
  it('adds funds and records a deposit', () => {
    const store = useTradeStore.getState()
    store.deposit(1000)
    expect(useTradeStore.getState().balance).toBe(1000)
    expect(useTradeStore.getState().deposits).toHaveLength(1)
  })

  it('ignores invalid amounts', () => {
    const store = useTradeStore.getState()
    store.deposit(-50)
    store.deposit(0)
    expect(useTradeStore.getState().balance).toBe(0)
  })
})

describe('openPosition', () => {
  it('opens a spot position and deducts full notional', () => {
    useTradeStore.getState().deposit(1000)
    const before = useTradeStore.getState()
    const result = before.openPosition(makeOrder({ quantity: 2, entryPrice: 100 }))

    const state = useTradeStore.getState()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.position.side).toBe('long')
    }
    expect(state.positions).toHaveLength(1)
    expect(state.balance).toBeCloseTo(800)
  })

  it('opens a futures position and deducts only margin', () => {
    useTradeStore.getState().deposit(1000)
    const state = useTradeStore.getState()
    state.openPosition(
      makeOrder({ mode: 'futures', leverage: 10, quantity: 1, entryPrice: 1000 }),
    )

    const after = useTradeStore.getState()
    expect(after.positions).toHaveLength(1)
    expect(after.positions[0].leverage).toBe(10)
    expect(after.balance).toBeCloseTo(900) // margin = 1000*1/10
  })

  it('rejects an order beyond account purchasing power', () => {
    useTradeStore.getState().deposit(100)
    const result = useTradeStore.getState().openPosition(
      makeOrder({ mode: 'spot', quantity: 10, entryPrice: 200 }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Insufficient balance')
    }
    expect(useTradeStore.getState().positions).toHaveLength(0)
  })

  it('rejects zero amount', () => {
    useTradeStore.getState().deposit(1000)
    const result = useTradeStore.getState().openPosition(makeOrder({ quantity: 0 }))
    expect(result.ok).toBe(false)
  })
})

describe('closePosition', () => {
  it('returns margin + profit for a winning long', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().openPosition(
      makeOrder({ mode: 'futures', leverage: 10, quantity: 1, entryPrice: 100 }),
    )
    const positionId = useTradeStore.getState().positions[0].id
    // margin = 10 -> balance 990; closing at 120 -> pnl=20
    useTradeStore.getState().closePosition(positionId, 120)

    const state = useTradeStore.getState()
    expect(state.balance).toBeCloseTo(1020)
    expect(state.positions).toHaveLength(0)
    expect(state.trades).toHaveLength(1)
    expect(state.trades[0].pnl).toBeCloseTo(20)
    expect(state.trades[0].reason).toBe('manual')
  })

  it('records losses on a losing short', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().openPosition(
      makeOrder({ mode: 'futures', leverage: 10, quantity: 1, entryPrice: 100, side: 'short' }),
    )
    const positionId = useTradeStore.getState().positions[0].id
    useTradeStore.getState().closePosition(positionId, 120)

    const state = useTradeStore.getState()
    expect(state.trades[0].pnl).toBeCloseTo(-20)
  })

  it('is a no-op for unknown position ids', () => {
    useTradeStore.getState().closePosition('does-not-exist', 100)
    expect(useTradeStore.getState().trades).toHaveLength(0)
  })
})

describe('liquidateIsolated', () => {
  it('loses only the locked margin — free balance survives (5k/2k senaryosu)', () => {
    useTradeStore.getState().deposit(5000)
    const state = useTradeStore.getState()
    // 10x, 200 adet @100 → 2.000 teminat kilitlenir, serbest 3.000 kalır.
    state.openPosition(makeOrder({ mode: 'futures', leverage: 10, quantity: 200, entryPrice: 100 }))
    expect(useTradeStore.getState().balance).toBe(3000)

    const positionId = useTradeStore.getState().positions[0].id
    // long liquidation price ~ 90.4 (bakım marjini %0.4 dahil)
    useTradeStore.getState().liquidateIsolated(positionId, 90.4)

    const after = useTradeStore.getState()
    expect(after.positions).toHaveLength(0)
    // KRİTİK: tüm bakiye sıfırlanmaz — yalnızca 2k kilitli teminat gider.
    expect(after.balance).toBe(3000)
    expect(after.trades[0].reason).toBe('liquidation')
    expect(after.trades[0].pnl).toBeCloseTo(-2000)
  })

  it('does not touch other open positions', () => {
    useTradeStore.getState().deposit(5000)
    const state = useTradeStore.getState()
    state.openPosition(makeOrder({ mode: 'futures', leverage: 10, quantity: 200, entryPrice: 100 }))
    state.openPosition(
      makeOrder({ symbol: 'ETHUSDT', mode: 'futures', leverage: 10, quantity: 10, entryPrice: 100 }),
    )
    // ETH teminatı 100 → serbest 2.900
    expect(useTradeStore.getState().balance).toBe(2900)

    const firstId = useTradeStore.getState().positions[0].id
    useTradeStore.getState().liquidateIsolated(firstId, 90.4)

    const after = useTradeStore.getState()
    expect(after.positions).toHaveLength(1)
    expect(after.positions[0].symbol).toBe('ETHUSDT')
    expect(after.balance).toBe(2900)
  })

  it('is a no-op for unknown position ids', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().liquidateIsolated('yok', 90)
    expect(useTradeStore.getState().balance).toBe(1000)
    expect(useTradeStore.getState().trades).toHaveLength(0)
  })
})

describe('liquidateCrossAccount', () => {
  function openCross(symbol = 'BTCUSDT', quantity = 200) {
    const res = useTradeStore.getState().fillNow({
      symbol,
      side: 'long',
      mode: 'futures',
      quantity,
      entryPrice: 100,
      leverage: 10,
      marginMode: 'cross',
    })
    expect(res.ok).toBe(true)
  }

  it('wipes the shared pool only after it is exhausted', () => {
    useTradeStore.getState().deposit(5000)
    openCross()
    // 2.000 kilitli → serbest 3.000
    expect(useTradeStore.getState().balance).toBe(3000)

    useTradeStore.getState().liquidateCrossAccount({ BTCUSDT: 80 })

    const after = useTradeStore.getState()
    expect(after.positions).toHaveLength(0)
    expect(after.balance).toBe(0)
    expect(after.trades[0].reason).toBe('liquidation')
    expect(after.trades[0].pnl).toBeCloseTo(-4000)
  })

  it('spares isolated positions when the cross pool wipes', () => {
    useTradeStore.getState().deposit(5000)
    const state = useTradeStore.getState()
    state.openPosition(makeOrder({ mode: 'futures', leverage: 10, quantity: 100, entryPrice: 100 }))
    openCross()
    // serbest: 5000 - 1000 (izole) - 2000 (cross) = 2000
    expect(useTradeStore.getState().balance).toBe(2000)

    useTradeStore.getState().liquidateCrossAccount({ BTCUSDT: 80 })

    const after = useTradeStore.getState()
    expect(after.positions).toHaveLength(1)
    expect(after.positions[0].marginMode ?? 'isolated').toBe('isolated')
    expect(after.balance).toBe(0)
  })

  it('is a no-op without cross positions', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().liquidateCrossAccount({ BTCUSDT: 1 })
    expect(useTradeStore.getState().balance).toBe(1000)
    expect(useTradeStore.getState().trades).toHaveLength(0)
  })
})

describe('spotBuy / spotSell', () => {
  it('buys coin: USDT balance decreases, coin balance increases', () => {
    useTradeStore.getState().deposit(1000)
    const result = useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 5, price: 100 })
    expect(result.ok).toBe(true)
    const s = useTradeStore.getState()
    expect(s.balance).toBeCloseTo(500)
    expect(s.spotBalances.BTC).toBeCloseTo(5)
    expect(s.spotTrades).toHaveLength(1)
    expect(s.spotTrades[0]).toMatchObject({ side: 'buy', symbol: 'BTCUSDT', quantity: 5, price: 100 })
  })

  it('rejects a buy without enough USDT', () => {
    useTradeStore.getState().deposit(100)
    const result = useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 5, price: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Insufficient USDT')
    expect(useTradeStore.getState().spotBalances.BTC ?? 0).toBe(0)
  })

  it('sells coin: coin balance decreases, USDT balance increases', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().spotBuy({ symbol: 'ETHUSDT', quantity: 20, price: 50 })
    const result = useTradeStore.getState().spotSell({ symbol: 'ETHUSDT', quantity: 10, price: 55 })
    expect(result.ok).toBe(true)
    const s = useTradeStore.getState()
    expect(s.spotBalances.ETH).toBeCloseTo(10)
    expect(s.balance).toBeCloseTo(550)
    expect(s.spotTrades[0]).toMatchObject({ side: 'sell', price: 55 })
  })

  it('rejects a sell without enough coin', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 2, price: 100 })
    const result = useTradeStore.getState().spotSell({ symbol: 'BTCUSDT', quantity: 5, price: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Insufficient BTC')
  })

  it('rejects invalid amounts', () => {
    useTradeStore.getState().deposit(1000)
    expect(useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: -1, price: 100 }).ok).toBe(false)
    expect(useTradeStore.getState().spotSell({ symbol: 'BTCUSDT', quantity: 0, price: 100 }).ok).toBe(false)
  })

  it('resetWallet clears spot balances', () => {
    useTradeStore.getState().deposit(1000)
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 5, price: 100 })
    useTradeStore.getState().resetWallet()
    expect(useTradeStore.getState().spotBalances.BTC ?? 0).toBe(0)
    expect(useTradeStore.getState().spotTrades).toHaveLength(0)
  })
})

describe('ortalama maliyet (spot + sanal)', () => {
  it('ek alımlarda ağırlıklı ortalamayı günceller', () => {
    useTradeStore.getState().deposit(10000)
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 1, price: 100 })
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 1, price: 200 })
    expect(useTradeStore.getState().spotAvgCosts.BTC).toBeCloseTo(150)
  })

  it('satışta ortalamayı korur, tamamı satılınca kaydı siler', () => {
    useTradeStore.getState().deposit(10000)
    useTradeStore.getState().spotBuy({ symbol: 'ETHUSDT', quantity: 10, price: 50 })
    useTradeStore.getState().spotSell({ symbol: 'ETHUSDT', quantity: 4, price: 60 })
    expect(useTradeStore.getState().spotAvgCosts.ETH).toBeCloseTo(50)
    useTradeStore.getState().spotSell({ symbol: 'ETHUSDT', quantity: 6, price: 60 })
    expect(useTradeStore.getState().spotAvgCosts.ETH).toBeUndefined()
  })

  it('sanal alımlarda ortalamayı ağırlıklı günceller', () => {
    const s = useTradeStore.getState()
    s.recordVirtualTrade('ENTES', 'buy', 100, 1000, 0)
    expect(useTradeStore.getState().virtualAvgCosts.ENTES).toBeCloseTo(10)
    useTradeStore.getState().recordVirtualTrade('ENTES', 'buy', 100, 2000, 100)
    // (100*10 + 100*20) / 200 = 15
    expect(useTradeStore.getState().virtualAvgCosts.ENTES).toBeCloseTo(15)
    // Satış ortalamayı değiştirmez.
    useTradeStore.getState().recordVirtualTrade('ENTES', 'sell', 50, 750, 200)
    expect(useTradeStore.getState().virtualAvgCosts.ENTES).toBeCloseTo(15)
  })
})

describe('sanal pending + TP/SL (AMM askıdaki emirler)', () => {
  it('bekleyen emir bırakır, alır ve iptal eder', () => {
    const s = useTradeStore.getState()
    const order = s.placeVirtualPending({
      symbol: 'ENTES',
      side: 'buy',
      amount: 100,
      limitPrice: 9,
      tpPrice: null,
      slPrice: null,
    })
    expect(useTradeStore.getState().virtualPending).toHaveLength(1)
    const taken = useTradeStore.getState().takeVirtualPending(order.id)
    expect(taken).toMatchObject({ symbol: 'ENTES', limitPrice: 9 })
    expect(useTradeStore.getState().virtualPending).toHaveLength(0)
    expect(useTradeStore.getState().takeVirtualPending(order.id)).toBeNull()
    const order2 = useTradeStore.getState().placeVirtualPending({
      symbol: 'ENTES',
      side: 'sell',
      amount: 5,
      limitPrice: 11,
      tpPrice: null,
      slPrice: null,
    })
    useTradeStore.getState().cancelVirtualPending(order2.id)
    expect(useTradeStore.getState().virtualPending).toHaveLength(0)
  })

  it('TP/SL lotu ekler, alır ve iptal eder', () => {
    const lot = useTradeStore.getState().addVirtualTpSl({
      symbol: 'ENTES',
      quantity: 10,
      tpPrice: 12,
      slPrice: 8,
    })
    expect(useTradeStore.getState().virtualTpSl).toHaveLength(1)
    const taken = useTradeStore.getState().takeVirtualTpSl(lot.id)
    expect(taken).toMatchObject({ quantity: 10, tpPrice: 12 })
    expect(useTradeStore.getState().virtualTpSl).toHaveLength(0)
    const lot2 = useTradeStore.getState().addVirtualTpSl({
      symbol: 'ENTES',
      quantity: 5,
      tpPrice: null,
      slPrice: 7,
    })
    useTradeStore.getState().cancelVirtualTpSl(lot2.id)
    expect(useTradeStore.getState().virtualTpSl).toHaveLength(0)
  })

  it('resetWallet sanal kuyrukları temizler', () => {
    const s = useTradeStore.getState()
    s.placeVirtualPending({ symbol: 'ENTES', side: 'buy', amount: 1, limitPrice: 1, tpPrice: null, slPrice: null })
    s.addVirtualTpSl({ symbol: 'ENTES', quantity: 1, tpPrice: 2, slPrice: null })
    s.resetWallet()
    expect(useTradeStore.getState().virtualPending).toHaveLength(0)
    expect(useTradeStore.getState().virtualTpSl).toHaveLength(0)
  })
})

describe('redeemPromo', () => {
  it('adds bonus USDT for a valid unused code (case-insensitive)', () => {
    const result = useTradeStore.getState().redeemPromo('DNZTRD100')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.amount).toBe(100)
    expect(useTradeStore.getState().balance).toBe(100)
    expect(useTradeStore.getState().promos).toContain('dnztrd100')
    expect(useTradeStore.getState().deposits).toHaveLength(1)
    expect(useTradeStore.getState().deposits[0].source).toBe('promo')
  })

  it('logs a card deposit with source "card"', () => {
    useTradeStore.getState().deposit(500)
    expect(useTradeStore.getState().deposits).toHaveLength(1)
    expect(useTradeStore.getState().deposits[0].source).toBe('card')
  })

  it('rejects a code that was already used', () => {
    useTradeStore.getState().redeemPromo('deniz100')
    const result = useTradeStore.getState().redeemPromo('deniz100')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('kullanıldı')
    expect(useTradeStore.getState().balance).toBe(100)
    expect(useTradeStore.getState().promos).toHaveLength(1)
  })

  it('rejects unknown codes', () => {
    const result = useTradeStore.getState().redeemPromo('gibberish')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Geçersiz')
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('resetWallet clears redeemed promos for the next account', () => {
    useTradeStore.getState().redeemPromo('dnztrd100')
    useTradeStore.getState().resetWallet()
    expect(useTradeStore.getState().promos).toHaveLength(0)
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('syncPromos marks remote codes used without crediting balance', () => {
    useTradeStore.getState().syncPromos(['dnztrd100'])
    expect(useTradeStore.getState().promos).toContain('dnztrd100')
    expect(useTradeStore.getState().balance).toBe(0)
    expect(useTradeStore.getState().deposits).toHaveLength(0)
    // Artık yerel kullanım da engellenir (çift bakiye yok).
    const result = useTradeStore.getState().redeemPromo('dnztrd100')
    expect(result.ok).toBe(false)
    expect(useTradeStore.getState().balance).toBe(0)
  })

  it('redeemPromoAsync credits when offline (no Supabase backend)', async () => {
    const result = await useTradeStore.getState().redeemPromoAsync('DNZTRD100')
    expect(result.ok).toBe(true)
    expect(useTradeStore.getState().balance).toBe(100)
  })
})

describe('spot TP/SL (Oto-Kar Al / Oto-Zarar Durdur)', () => {
  const input = {
    symbol: 'BTCUSDT',
    mode: 'spot' as const,
    side: 'buy' as const,
    quantity: 2,
    entryPrice: 100,
    tpPrice: 150,
    slPrice: 80,
  }

  it('registers a spot position when a spot buy carries TP/SL', () => {
    useTradeStore.setState({ balance: 1000 })
    const result = useTradeStore.getState().fillNow(input)
    expect(result.ok).toBe(true)
    const positions = useTradeStore.getState().spotPositions
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({ symbol: 'BTCUSDT', quantity: 2, tpPrice: 150, slPrice: 80 })
    expect(useTradeStore.getState().spotBalances.BTC).toBeCloseTo(2)
  })

  it('does NOT touch spot positions when a spot buy has no TP/SL', () => {
    useTradeStore.setState({ balance: 1000 })
    useTradeStore.getState().fillNow({ ...input, tpPrice: undefined, slPrice: undefined })
    expect(useTradeStore.getState().spotPositions).toHaveLength(0)
  })

  it('closeSpotPosition sells the lot back and removes the position', () => {
    useTradeStore.setState({ balance: 1000 })
    useTradeStore.getState().fillNow(input)
    const pos = useTradeStore.getState().spotPositions[0]
    useTradeStore.getState().closeSpotPosition(pos.id, 160)

    expect(useTradeStore.getState().spotPositions).toHaveLength(0)
    expect(useTradeStore.getState().spotBalances.BTC ?? 0).toBe(0)
    expect(useTradeStore.getState().balance).toBeCloseTo(1000 - 2 * 100 + 2 * 160)
  })

  it('lowest priority: TP/SL is independent of a plain spot buy', () => {
    useTradeStore.setState({ balance: 1000 })
    const result = useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 1, price: 100 })
    expect(result.ok).toBe(true)
    expect(useTradeStore.getState().spotPositions).toHaveLength(0)
  })
})

describe('persistence', () => {
  it('persists wallet state to localStorage', () => {
    // simulate an active session so the session-scoped storage writes
    localStorage.setItem(
      'deniztradx_session',
      JSON.stringify({ id: 'u_test', username: 'tester', email: 't@test.co', createdAt: 1 }),
    )
    useTradeStore.getState().deposit(500)
    const raw = localStorage.getItem('deniztradx_wallet_u_test')
    expect(raw).toBeTruthy()
    expect(raw).toContain('500')
  })
})