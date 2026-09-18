import { beforeEach, describe, expect, it } from 'vitest'
import {
  createBotForumPost,
  isBotUsername,
} from '@/services/forumService'
import {
  listCoinNewsPublic,
  listCoinOverridesPublic,
} from '@/services/coinMetaService'
import { loadTradingState } from '@/services/tradingSyncService'
import {
  DEFAULT_RISK_PARAMS,
  getRiskParams,
  resetRiskParamsCache,
} from '@/services/riskConfigService'
import { scaleBotAmount, triggerElonMusk } from '@/services/botSimulationService'
import { useOrderStore } from '@/store/orderStore'
import { useTradeStore } from '@/store/tradeStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useOrderStore.getState().resetOrders()
})

describe('botlar: default silüet + mavi tik', () => {
  it('botlar tanınır (eski Faik Erdem adı rozet uyumluluğu korunur)', () => {
    expect(isBotUsername('Elon Musk')).toBe(true)
    expect(isBotUsername('Entes Yöneticisi')).toBe(true)
    expect(isBotUsername('Faik Erdem')).toBe(true)
    expect(isBotUsername('İlham Memiş')).toBe(true)
    expect(isBotUsername('İhsan Memiş')).toBe(true)
    expect(isBotUsername('Kripto Kaplanı')).toBe(true)
    expect(isBotUsername('sıradan kullanıcı')).toBe(false)
  })

  it('bot mesajı mavi tik + avatar yok (default silüet) ile düşer', async () => {
    for (const name of ['Elon Musk', 'Entes Yöneticisi', 'İlham Memiş', 'Kripto Kaplanı']) {
      const post = await createBotForumPost(name, 'test mesajı', 5)
      expect(post).toMatchObject({ verifiedTier: 'admin', avatarUrl: null })
    }
  })
})

describe('cihazlar arası işlem senkronu (hydrate)', () => {
  it('hydrateTradingState bakiyeye dokunmadan uygular', () => {
    useTradeStore.setState({ balance: 777 })
    useTradeStore.getState().hydrateTradingState({
      positions: [
        {
          id: 'pos_mob_1',
          symbol: 'BTCUSDT',
          side: 'long',
          entryPrice: 50000,
          quantity: 0.1,
          leverage: 10,
          mode: 'futures',
          openedAt: 1,
        },
      ],
      spotBalances: { BTC: 0.5 },
      spotPositions: [],
      trades: [],
      spotTrades: [],
    })
    const s = useTradeStore.getState()
    expect(s.balance).toBe(777)
    expect(s.positions.map((p) => p.id)).toEqual(['pos_mob_1'])
    expect(s.spotBalances).toEqual({ BTC: 0.5 })
  })

  it('hydrateOrders + resetOrders', () => {
    useOrderStore.getState().hydrateOrders([
      {
        id: 'o_mob_1',
        symbol: 'ETHUSDT',
        mode: 'futures',
        side: 'long',
        orderType: 'limit',
        quantity: 1,
        entryPrice: 3000,
        leverage: 5,
        at: 1,
      },
    ])
    expect(useOrderStore.getState().pendingOrders.map((o) => o.id)).toEqual(['o_mob_1'])
    useOrderStore.getState().resetOrders()
    expect(useOrderStore.getState().pendingOrders).toEqual([])
  })
})

describe('çevrimdışı servisler sessiz boş döner', () => {
  it('coin meta + trading state', async () => {
    await expect(listCoinOverridesPublic()).resolves.toEqual({})
    await expect(listCoinNewsPublic('BTCUSDT')).resolves.toEqual([])
    const snap = await loadTradingState('u_yok')
    expect(snap).toMatchObject({ positions: [], updatedAt: 0 })
  })
})

describe('adil likidasyon: risk parametreleri + bot ölçeği', () => {
  beforeEach(() => {
    resetRiskParamsCache()
    localStorage.setItem(
      'deniztradx_session',
      JSON.stringify({ id: 'u_admin', username: 'superadmin', email: 'a@x.com', createdAt: 1 }),
    )
  })

  it('çevrimdışı risk varsayılanları döner', async () => {
    await expect(getRiskParams()).resolves.toEqual(DEFAULT_RISK_PARAMS)
    expect(DEFAULT_RISK_PARAMS.maintenanceMarginRate).toBe(0.004)
    expect(DEFAULT_RISK_PARAMS.liqConfirmTicks).toBe(3)
    expect(DEFAULT_RISK_PARAMS.botMaxPoolFraction).toBe(0.02)
  })

  it('sığ havuzda bot tutarı orantılanır', async () => {
    // SVGC havuzu 500.000 USDT → %2 üst sınır = 10.000 USDT
    const { amount, scaled } = await scaleBotAmount('SVGC', 50000)
    expect(scaled).toBe(true)
    expect(amount).toBeLessThanOrEqual(10000)
    expect(amount).toBeGreaterThan(0)
  })

  it('derin havuzda bot tutarı aynen geçer', async () => {
    // ENTES havuzu 50.000.000 USDT → 500.000 talebi sınır altında
    const { amount, scaled } = await scaleBotAmount('ENTES', 500000)
    expect(scaled).toBe(false)
    expect(amount).toBe(500000)
  })

  it('Elon hamlesi ölçekli yapılır, etkisi sınırlı kalır', async () => {
    const res = await triggerElonMusk()
    expect(res.trade).not.toBeNull()
    expect(res.trade!.usdtAmount).toBeLessThanOrEqual(10000)
    expect(res.trade!.priceImpactPct).toBeGreaterThan(0)
  })

  it('margin-call bayrağı damgalanır ve temizlenir', () => {
    useTradeStore.setState({ balance: 1000 })
    useTradeStore.getState().openPosition({
      symbol: 'BTCUSDT',
      side: 'long',
      mode: 'futures',
      quantity: 1,
      entryPrice: 100,
      leverage: 10,
    })
    const id = useTradeStore.getState().positions[0].id
    expect(useTradeStore.getState().positions[0].marginCalledAt ?? null).toBeNull()
    useTradeStore.getState().markMarginCalled(id)
    expect(useTradeStore.getState().positions[0].marginCalledAt).toBeGreaterThan(0)
    useTradeStore.getState().clearMarginCalled(id)
    expect(useTradeStore.getState().positions[0].marginCalledAt ?? null).toBeNull()
  })
})
