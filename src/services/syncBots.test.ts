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
import { useOrderStore } from '@/store/orderStore'
import { useTradeStore } from '@/store/tradeStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useOrderStore.getState().resetOrders()
})

describe('botlar: default silüet + mavi tik', () => {
  it('4 bot tanınır (ilham/ihsan yazım toleranslı)', () => {
    expect(isBotUsername('Elon Musk')).toBe(true)
    expect(isBotUsername('Faik Erdem')).toBe(true)
    expect(isBotUsername('İlham Memiş')).toBe(true)
    expect(isBotUsername('İhsan Memiş')).toBe(true)
    expect(isBotUsername('Kripto Kaplanı')).toBe(true)
    expect(isBotUsername('sıradan kullanıcı')).toBe(false)
  })

  it('bot mesajı mavi tik + avatar yok (default silüet) ile düşer', async () => {
    for (const name of ['Elon Musk', 'Faik Erdem', 'İlham Memiş', 'Kripto Kaplanı']) {
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
