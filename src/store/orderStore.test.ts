import { beforeEach, describe, expect, it } from 'vitest'
import { useOrderStore } from '@/store/orderStore'
import { useTradeStore } from '@/store/tradeStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useOrderStore.setState({ pendingOrders: [] })
})

describe('orderStore.placeOrder', () => {
  it('fills a market order immediately', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'market',
      quantity: 1,
      entryPrice: 100,
      leverage: 10,
      marketPrice: 100,
    })

    expect(res.ok).toBe(true)
    expect('pending' in res ? res.pending : undefined).toBeUndefined()
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
    expect(useTradeStore.getState().positions).toHaveLength(1)
  })

  it('rejects a market order with Post-Only', () => {
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'market',
      quantity: 1,
      entryPrice: 100,
      leverage: 10,
      postOnly: true,
    })

    expect(res).toEqual({ ok: false, error: 'Piyasa emri Post-Only ile kullanılamaz.' })
  })

  it('rejects a Post-Only limit that would fill immediately', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'limit',
      quantity: 1,
      // Alış limiti piyasanın üstünde → anında gerçekleşir → Post-Only reddeder.
      entryPrice: 105,
      leverage: 10,
      marketPrice: 100,
      postOnly: true,
    })

    expect(res).toEqual({ ok: false, error: 'Post-Only: emir anında gerçekleşir.' })
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
    expect(useTradeStore.getState().positions).toHaveLength(0)
  })

  it('parks a Post-Only limit that rests below the market', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'limit',
      quantity: 1,
      entryPrice: 90,
      leverage: 10,
      marketPrice: 100,
      postOnly: true,
    })

    expect(res).toEqual({ ok: true, pending: true })
    expect(useOrderStore.getState().pendingOrders).toHaveLength(1)
    expect(useTradeStore.getState().positions).toHaveLength(0)
  })

  it('parks a stop-market order as pending', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'stop-market',
      quantity: 1,
      entryPrice: 100,
      stopPrice: 105,
      leverage: 10,
      marketPrice: 100,
    })

    expect(res).toEqual({ ok: true, pending: true })
    expect(useOrderStore.getState().pendingOrders[0].stopPrice).toBe(105)
    expect(useTradeStore.getState().positions).toHaveLength(0)
  })

  it('fires one OCO leg and clears its sibling', () => {
    useTradeStore.setState({ balance: 1000 })
    useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'oco',
      quantity: 1,
      entryPrice: 100,
      stopPrice: 95,
      leverage: 10,
    })
    const legs = useOrderStore.getState().pendingOrders
    expect(legs).toHaveLength(2)

    const res = useOrderStore.getState().fireOrder(legs[1].id, 95)
    expect(res.ok).toBe(true)
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
    expect(useTradeStore.getState().positions).toHaveLength(1)
  })

  it('fills a buy limit immediately when the limit is at/above the market', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'limit',
      quantity: 1,
      entryPrice: 105,
      leverage: 10,
      marketPrice: 100,
    })

    expect(res.ok).toBe(true)
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
    expect(useTradeStore.getState().positions).toHaveLength(1)
    // Piyasa fiyattan ucuz → gerçekleşme piyasa fiyattan olur.
    expect(useTradeStore.getState().positions[0].entryPrice).toBe(100)
  })

  it('parks a buy limit below the market instead of filling it', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'limit',
      quantity: 1,
      entryPrice: 90,
      leverage: 10,
      marketPrice: 100,
    })

    expect(res).toEqual({ ok: true, pending: true })
    expect(useOrderStore.getState().pendingOrders[0].orderType).toBe('limit')
    expect(useTradeStore.getState().positions).toHaveLength(0)
  })

  it('parks a sell limit above the market instead of filling it', () => {
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 1, price: 100 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'spot',
      side: 'sell',
      orderType: 'limit',
      quantity: 0.5,
      entryPrice: 110,
      leverage: 1,
      marketPrice: 100,
    })

    expect(res).toEqual({ ok: true, pending: true })
    expect(useOrderStore.getState().pendingOrders).toHaveLength(1)
  })

  it('fills a sell limit immediately when the limit is at/below the market', () => {
    useTradeStore.setState({ balance: 1000 })
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 1, price: 100 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'spot',
      side: 'sell',
      orderType: 'limit',
      quantity: 0.5,
      entryPrice: 90,
      leverage: 1,
      marketPrice: 100,
    })

    expect(res.ok).toBe(true)
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
  })

  it('creates two linked OCO legs', () => {
    useTradeStore.setState({ balance: 1000 })
    const res = useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'oco',
      quantity: 1,
      entryPrice: 100,
      stopPrice: 95,
      leverage: 10,
    })

    expect(res).toEqual({ ok: true, pending: true })
    const orders = useOrderStore.getState().pendingOrders
    expect(orders).toHaveLength(2)
    expect(orders.map((o) => o.leg).sort()).toEqual(['limit', 'stop'])
    expect(orders[0].ocoId).toBe(orders[1].ocoId)
  })

  it('seeds a trailing stop with the market price as its peak', () => {
    useTradeStore.setState({ balance: 1000 })
    useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'trailing',
      quantity: 1,
      entryPrice: 100,
      leverage: 10,
      marketPrice: 100,
      cbRate: 0.5,
    })

    const order = useOrderStore.getState().pendingOrders[0]
    expect(order.orderType).toBe('trailing')
    expect(order.peakPrice).toBe(100)
  })
})

describe('orderStore.cancelPendingOrder', () => {
  it('removes a pending order and its OCO sibling', () => {
    useTradeStore.setState({ balance: 1000 })
    useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'oco',
      quantity: 1,
      entryPrice: 100,
      stopPrice: 95,
      leverage: 10,
    })

    const { pendingOrders } = useOrderStore.getState()
    expect(pendingOrders).toHaveLength(2)

    useOrderStore.getState().cancelPendingOrder(pendingOrders[0].id)
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
  })

  it('removes both legs when the stop leg is cancelled (no orphan orders)', () => {
    useTradeStore.setState({ balance: 1000 })
    useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'oco',
      quantity: 1,
      entryPrice: 100,
      stopPrice: 95,
      leverage: 10,
    })

    const { pendingOrders } = useOrderStore.getState()
    expect(pendingOrders).toHaveLength(2)
    const stopLeg = pendingOrders.find((o) => o.leg === 'stop')
    expect(stopLeg).toBeDefined()

    useOrderStore.getState().cancelPendingOrder(stopLeg!.id)
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
  })
})

describe('orderStore.fireOrder', () => {
  it('opens a position when fired', () => {
    useTradeStore.setState({ balance: 1000 })
    useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'limit',
      quantity: 1,
      entryPrice: 90,
      leverage: 10,
    })

    const id = useOrderStore.getState().pendingOrders[0].id
    const res = useOrderStore.getState().fireOrder(id, 90)

    expect(res.ok).toBe(true)
    expect(useOrderStore.getState().pendingOrders).toHaveLength(0)
    const pos = useTradeStore.getState().positions[0]
    expect(pos.entryPrice).toBe(90)
    expect(pos.quantity).toBe(1)
  })

  it('opens the position with the tp/sl attached', () => {
    useTradeStore.setState({ balance: 1000 })
    useOrderStore.getState().placeOrder({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      orderType: 'limit',
      quantity: 1,
      entryPrice: 90,
      leverage: 10,
      tpPrice: 110,
      slPrice: 80,
    })

    const id = useOrderStore.getState().pendingOrders[0].id
    useOrderStore.getState().fireOrder(id, 90)

    const pos = useTradeStore.getState().positions[0]
    expect(pos.tpPrice).toBe(110)
    expect(pos.slPrice).toBe(80)
  })

  it('returns not-found error for an unknown order id', () => {
    const res = useOrderStore.getState().fireOrder('missing', 100)
    expect(res).toEqual({ ok: false, error: 'Emir bulunamadı.' })
  })
})

describe('tradeStore.fillNow', () => {
  it('spot buy respects FOK marketability', () => {
    useTradeStore.setState({ balance: 100 })

    const fok = useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'spot',
      side: 'buy',
      quantity: 2,
      entryPrice: 100,
      tif: 'FOK',
    })
    expect(fok).toEqual({ ok: false, error: 'FOK: tam miktar karşılanamıyor.' })

    // Komisyon dahil (100 + 0.1) karşılanmalı — bakiyeyi tam sınıra çek.
    useTradeStore.setState({ balance: 101 })
    const okFill = useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'spot',
      side: 'buy',
      quantity: 1,
      entryPrice: 100,
      tif: 'FOK',
    })
    expect(okFill.ok).toBe(true)
    expect(useTradeStore.getState().spotBalances.BTC).toBe(1)
  })

  it('spot buy IOC fills the maximum affordable quantity', () => {
    useTradeStore.setState({ balance: 150 })
    const res = useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'spot',
      side: 'buy',
      quantity: 3,
      entryPrice: 100,
      tif: 'IOC',
    })

    expect(res.ok).toBe(true)
    // Komisyon dahil karşılanabilir azami miktar: 150 / (100 * 1.001).
    expect(useTradeStore.getState().spotBalances.BTC).toBeCloseTo(150 / 100.1)
  })

  it('reduceOnly closes an existing futures position', () => {
    useTradeStore.setState({ balance: 1000 })
    useTradeStore.getState().openPosition({
      symbol: 'BTCUSDT',
      side: 'long',
      mode: 'futures',
      quantity: 1,
      entryPrice: 100,
      leverage: 10,
    })
    expect(useTradeStore.getState().positions).toHaveLength(1)

    const res = useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'short',
      quantity: 1,
      entryPrice: 120,
      reduceOnly: true,
    })

    expect(res.ok).toBe(true)
    expect(useTradeStore.getState().positions).toHaveLength(0)
    const trade = useTradeStore.getState().trades[0]
    expect(trade.reason).toBe('reduce')
    expect(trade.pnl).toBe(20)
  })

  it('futures IOC fills only the affordable quantity', () => {
    useTradeStore.setState({ balance: 150 })
    const res = useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      quantity: 5,
      entryPrice: 100,
      leverage: 10,
      tif: 'IOC',
    })

    expect(res.ok).toBe(true)
    // 150 USDT × 10x = 1500 USDT güç ≥ 500 USDT ihtiyaç → tamamı dolar.
    expect(useTradeStore.getState().positions[0].quantity).toBe(5)
  })

  it('futures IOC caps the fill at leveraged buying power', () => {
    useTradeStore.setState({ balance: 100 })
    const res = useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      quantity: 20,
      entryPrice: 100,
      leverage: 10,
      tif: 'IOC',
    })

    expect(res.ok).toBe(true)
    // 100 USDT × 10x = 1000 USDT güç → en fazla 10 adet.
    expect(useTradeStore.getState().positions[0].quantity).toBe(10)
  })

  it('opening via fillNow attaches tpPrice and slPrice to the position', () => {
    useTradeStore.setState({ balance: 1000 })
    useTradeStore.getState().fillNow({
      symbol: 'BTCUSDT',
      mode: 'futures',
      side: 'long',
      quantity: 1,
      entryPrice: 100,
      leverage: 10,
      tpPrice: 120,
      slPrice: 90,
    })

    const pos = useTradeStore.getState().positions[0]
    expect(pos.tpPrice).toBe(120)
    expect(pos.slPrice).toBe(90)
  })
})