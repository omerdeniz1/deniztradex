import { beforeEach, describe, expect, it } from 'vitest'
import { login, register } from '@/services/authService'
import { deriveWalletNo, getMoneyRestrictions } from '@/services/supabaseWallet'
import {
  listTransferableAssets,
  listTransferHistory,
  lookupTransferTarget,
  transferAsset,
} from '@/services/transferService'
import { useTradeStore } from '@/store/tradeStore'
import { useDnzStore } from '@/store/dnzStore'

beforeEach(() => {
  localStorage.clear()
  useTradeStore.getState().resetWallet()
  useDnzStore.getState().resetDnz()
})

async function registerWithFunds(username: string, email: string, usdt: number) {
  const user = await register({ username, email, password: 'sifre123' })
  useTradeStore.getState().deposit(usdt)
  return user
}

describe('transferService (yerel mod, aynı cihaz)', () => {
  it('cüzdan numaraları kararlı ve benzersizdir', async () => {
    const a = await register({ username: 'ctran1', email: 'ct1@x.com', password: 'sifre123' })
    const b = await register({ username: 'ctran2', email: 'ct2@x.com', password: 'sifre123' })
    expect(deriveWalletNo(a.id)).toMatch(/^WT-[0-9A-F]{8}$/)
    expect(deriveWalletNo(a.id)).not.toBe(deriveWalletNo(b.id))
    expect(deriveWalletNo(a.id)).toBe(deriveWalletNo(a.id))
  })

  it('alıcıyı cüzdan no veya kullanıcı adıyla bulur, kendini reddeder', async () => {
    const a = await register({ username: 'aliciw', email: 'aw@x.com', password: 'sifre123' })
    await register({ username: 'gonderenw', email: 'gw@x.com', password: 'sifre123' })
    const byNo = await lookupTransferTarget(deriveWalletNo(a.id))
    expect(byNo).toMatchObject({ username: 'aliciw' })
    const byName = await lookupTransferTarget('ALICIW')
    expect(byName.walletNo).toBe(byNo.walletNo)
    await expect(lookupTransferTarget('gonderenw')).rejects.toThrow('Kendine')
    await expect(lookupTransferTarget('WT-FFFFFFFF')).rejects.toThrow('bulunamadı')
  })

  it('USDT gönderir: gönderen düşer, alıcı artar, geçmişe işler', async () => {
    const a = await registerWithFunds('usdtA', 'ua@x.com', 500)
    const b = await register({ username: 'usdtB', email: 'ub@x.com', password: 'sifre123' })
    // Gönderen olarak giriş yap (kayıt sonrası oturum B'dedir — A'ya dön,
    // bakiye persist'ten 500 olarak geri yüklenir).
    await login('usdtA', 'sifre123')
    await useTradeStore.persist.rehydrate()
    expect(useTradeStore.getState().balance).toBeCloseTo(500)
    const res = await transferAsset(deriveWalletNo(b.id), 'USDT', 200)
    // %1.2 ücret: gönderen 202.4 öder, alıcı 200 alır.
    expect(res).toMatchObject({ asset: 'USDT', amount: 200, fee: 2.4 })
    expect(useTradeStore.getState().balance).toBeCloseTo(297.6)
    void a
    // Alıcı tarafın blob'u güncellenmiştir.
    const blob = JSON.parse(
      localStorage.getItem(`deniztradx_wallet_${b.id}`) ?? '{}',
    ) as { state?: { balance?: number } }
    expect(blob.state?.balance).toBeCloseTo(200)
    const hist = await listTransferHistory()
    expect(hist[0]).toMatchObject({ direction: 'out', asset: 'USDT', amount: 200 })
  })

  it('spot coin gönderir: miktar ve maliyet taşınır', async () => {
    await registerWithFunds('spotA', 'sa@x.com', 10000)
    const b = await register({ username: 'spotB', email: 'sb@x.com', password: 'sifre123' })
    await login('spotA', 'sifre123')
    useTradeStore.getState().deposit(10000)
    useTradeStore.getState().spotBuy({ symbol: 'BTCUSDT', quantity: 1, price: 100 })
    const res = await transferAsset(deriveWalletNo(b.id), 'BTC', 0.4)
    // %1.2 ücret: gönderen 0.4048 düşer, alıcı 0.4 alır.
    expect(res).toMatchObject({ asset: 'BTC', amount: 0.4 })
    expect(res.fee).toBeCloseTo(0.0048)
    expect(useTradeStore.getState().spotBalances.BTC).toBeCloseTo(0.5952)
    const blob = JSON.parse(
      localStorage.getItem(`deniztradx_wallet_${b.id}`) ?? '{}',
    ) as { state?: { spotBalances?: Record<string, number>; spotAvgCosts?: Record<string, number> } }
    expect(blob.state?.spotBalances?.BTC).toBeCloseTo(0.4)
    expect(blob.state?.spotAvgCosts?.BTC).toBeCloseTo(100)
  })

  it('yetersiz bakiyede ve geçersiz girdide reddeder', async () => {
    await registerWithFunds('zinA', 'za@x.com', 50)
    const b = await register({ username: 'zinB', email: 'zb@x.com', password: 'sifre123' })
    await login('zinA', 'sifre123')
    useTradeStore.getState().deposit(50)
    await expect(transferAsset(deriveWalletNo(b.id), 'USDT', 999)).rejects.toThrow('Yetersiz')
    await expect(transferAsset(deriveWalletNo(b.id), 'USDT', 0)).rejects.toThrow()
    await expect(transferAsset('   ', 'USDT', 10)).rejects.toThrow()
  })

  it('DNZ gönderir: gönderen düşer, alıcı blob artar, listede görünür', async () => {
    await register({ username: 'dnzA', email: 'da@x.com', password: 'sifre123' })
    const b = await register({ username: 'dnzB', email: 'db@x.com', password: 'sifre123' })
    await login('dnzA', 'sifre123')
    useDnzStore.getState().buyDnz({ qty: 50, price: 0.5, usdtCost: 25 })
    const res = await transferAsset(deriveWalletNo(b.id), 'DNZ', 20)
    // %1.2 ücret: gönderen 20.24 düşer, alıcı 20 alır.
    expect(res).toMatchObject({ asset: 'DNZ', amount: 20 })
    expect(res.fee).toBeCloseTo(0.24)
    expect(useDnzStore.getState().balance).toBeCloseTo(29.76)
    const blob = JSON.parse(
      localStorage.getItem(`deniztradx_dnz_${b.id}`) ?? '{}',
    ) as { state?: { balance?: number } }
    expect(blob.state?.balance).toBeCloseTo(20)
    const assets = await listTransferableAssets()
    expect(assets.find((a) => a.asset === 'DNZ')).toMatchObject({ qty: 29.76, kind: 'dnz' })
    // Sanal listeyle çiftlenmez: tek DNZ girdisi olur.
    expect(assets.filter((a) => a.asset === 'DNZ')).toHaveLength(1)
    const hist = await listTransferHistory()
    expect(hist[0]).toMatchObject({ direction: 'out', asset: 'DNZ', amount: 20 })
  })

  it('DNZ yetersiz bakiyede reddeder', async () => {
    await register({ username: 'dnzC', email: 'dc@x.com', password: 'sifre123' })
    const b = await register({ username: 'dnzD', email: 'dd@x.com', password: 'sifre123' })
    await login('dnzC', 'sifre123')
    useDnzStore.getState().buyDnz({ qty: 5, price: 0.5, usdtCost: 2.5 })
    await expect(transferAsset(deriveWalletNo(b.id), 'DNZ', 99)).rejects.toThrow('Yetersiz')
  })

  it('%1.2 ücret: tutarı karşılayan ama ücreti karşılamayan bakiye reddedilir', async () => {
    await registerWithFunds('ucretA', 'ua2@x.com', 100)
    const b = await register({ username: 'ucretB', email: 'ub2@x.com', password: 'sifre123' })
    await login('ucretA', 'sifre123')
    await useTradeStore.persist.rehydrate()
    // 100 bakiye 100'lük transfere yetmez (101.2 gerekir).
    await expect(transferAsset(deriveWalletNo(b.id), 'USDT', 100)).rejects.toThrow('Yetersiz')
    // 98'lik transfer olur: 98 + 1.18 = 99.18 düşer.
    const res = await transferAsset(deriveWalletNo(b.id), 'USDT', 98)
    expect(res.fee).toBeCloseTo(1.18)
    expect(useTradeStore.getState().balance).toBeCloseTo(0.82)
  })

  it('yeni kayıt para işlemlerine kapalı başlar', async () => {
    const u = await register({ username: 'kisitliu', email: 'k@x.com', password: 'sifre123' })
    await expect(getMoneyRestrictions(u.id)).resolves.toEqual({
      depositBlocked: true,
      withdrawBlocked: true,
    })
  })
})
