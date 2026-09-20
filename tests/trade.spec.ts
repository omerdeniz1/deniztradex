import { expect, test } from '@playwright/test'
import {
  fundViaPromo,
  openVirtualTrade,
  readVirtualHoldings,
  readWallet,
  registerViaUI,
  tradePanelRoot,
  uniqueUser,
} from './helpers'

/**
 * Kritik Al/Sat uçtan uca senaryoları (yerel backend — deterministik).
 * Sanal AMM (ENTES) üzerinden: kayıt → fonlama → alış → satış, bakiye
 * matematiği localStorage blob'larından milimetrik doğrulanır.
 */

// ENTES tohum havuzu (VIRTUAL_SEED ile birebir — beklenti aynı formülle).
const R_USDT = 50_000_000
const R_TOKEN = 5_000_000
const FEE = 0.003

function buyQuote(usdtIn: number): number {
  const afterFee = usdtIn * (1 - FEE)
  return R_TOKEN - (R_USDT * R_TOKEN) / (R_USDT + afterFee)
}

test.describe('Sanal AMM al-sat (ENTES)', () => {
  test('kayıt → fonlama → alış: bakiye ve coin miktarı tam hesaplanır', async ({ page, isMobile }) => {
    const u = uniqueUser('e2ebuy')
    await registerViaUI(page, u.username, u.email, u.password)
    await fundViaPromo(page)

    await openVirtualTrade(page, 'ENTES', isMobile, 'buy')
    const panel = tradePanelRoot(page, isMobile)
    await panel.locator('input[aria-label="Order amount"]').fill('50')
    await panel.getByRole('button', { name: 'ENTES Al' }).click()
    await expect(page.getByText(/alındı/i).first()).toBeVisible()

    // USDT: 100 − 50 = 50 tam.
    const wallet = await readWallet(page)
    expect(wallet.balance).toBe(50)
    // Coin: AMM formülüyle birebir (6 ondalık hassasiyet).
    const expected = buyQuote(50)
    const holdings = await readVirtualHoldings(page)
    expect(holdings['ENTES'] ?? 0).toBeCloseTo(expected, 6)

    // Cüzdan tablosunda görünür.
    await page.goto('/#/wallet')
    await expect(page.getByText('Sanal Varlıklar')).toBeVisible()
    await expect(page.getByText('ENTES').first()).toBeVisible()
  })

  test('satış: USDT karşılığı tam yansır, coin düşer', async ({ page, isMobile }) => {
    const u = uniqueUser('e2esell')
    await registerViaUI(page, u.username, u.email, u.password)
    await fundViaPromo(page)

    await openVirtualTrade(page, 'ENTES', isMobile, 'buy')
    const panel = tradePanelRoot(page, isMobile)
    await panel.locator('input[aria-label="Order amount"]').fill('50')
    await panel.getByRole('button', { name: 'ENTES Al' }).click()
    await expect(page.getByText(/alındı/i).first()).toBeVisible()

    const before = await readVirtualHoldings(page)
    const held = before['ENTES'] ?? 0
    expect(held).toBeGreaterThan(0)
    const sellQty = held / 2

    await openVirtualTrade(page, 'ENTES', isMobile, 'sell')
    const panelSell = tradePanelRoot(page, isMobile)
    await panelSell.locator('input[aria-label="Order amount"]').fill(String(sellQty))
    await panelSell.getByRole('button', { name: 'ENTES Sat' }).click()
    await expect(page.getByText(/alındı/i).first()).toBeVisible()

    // Satış kotasyonu: token girişinden USDT çıkış (ücret dahil).
    const afterFee = sellQty * (1 - FEE)
    // Alış sonrası havuz: R_usdt + 49.85, R_token − tokenOut(50).
    const rUsdt = R_USDT + 50 * (1 - FEE)
    const rToken = R_TOKEN - buyQuote(50)
    const expectedUsdt = rUsdt - (rUsdt * rToken) / (rToken + afterFee)
    const wallet = await readWallet(page)
    expect(wallet.balance).toBeCloseTo(Math.round((50 + expectedUsdt) * 100) / 100, 2)
    const holdings = await readVirtualHoldings(page)
    expect(holdings['ENTES'] ?? 0).toBeCloseTo(held - sellQty, 6)
  })

  test('eksi bakiye bugı: yetersiz bakiyeyle alım reddedilir, bakiye korunur', async ({
    page,
    isMobile,
  }) => {
    const u = uniqueUser('e2epoor')
    await registerViaUI(page, u.username, u.email, u.password)
    await fundViaPromo(page)

    await openVirtualTrade(page, 'ENTES', isMobile, 'buy')
    const panel = tradePanelRoot(page, isMobile)
    await panel.locator('input[aria-label="Order amount"]').fill('999999')
    await panel.getByRole('button', { name: 'ENTES Al' }).click()
    await expect(page.getByText('Yetersiz USDT bakiyesi.')).toBeVisible()

    const wallet = await readWallet(page)
    expect(wallet.balance).toBe(100)
    expect((await readVirtualHoldings(page))['ENTES'] ?? 0).toBe(0)
  })

  test('geçersiz parametreler: çökme yok, doğru hata + kurtarma', async ({ page, isMobile }) => {
    const clean = uniqueUser('e2ebad')
    await registerViaUI(page, clean.username, clean.email, clean.password)
    await fundViaPromo(page)

    await openVirtualTrade(page, 'ENTES', isMobile, 'buy')
    const panelBad = tradePanelRoot(page, isMobile)
    const amount = panelBad.locator('input[aria-label="Order amount"]')
    const submit = panelBad.getByRole('button', { name: 'ENTES Al' })

    for (const bad of ['-5', '0', 'abc$!x']) {
      await amount.fill(bad)
      await submit.click()
      await expect(page.getByText('Geçerli bir tutar girin.')).toBeVisible()
    }
    // Aşırı büyük tutar bakiye kapısına takılır (çökme yok, doğru hata).
    await amount.fill('1e30')
    await submit.click()
    await expect(page.getByText('Yetersiz USDT bakiyesi.')).toBeVisible()

    // Panel hâlâ çalışıyor: geçerli emir gerçekleşir (kurtarma).
    await amount.fill('10')
    await submit.click()
    await expect(page.getByText(/alındı/i).first()).toBeVisible()
    const wallet = await readWallet(page)
    expect(wallet.balance).toBe(90)
  })

  test('spot limit emir askıya park eder (gerçekleşme yok, çökme yok)', async ({
    page,
    isMobile,
  }) => {
    const u = uniqueUser('e2epark')
    await registerViaUI(page, u.username, u.email, u.password)
    await fundViaPromo(page)

    // Satış limiti piyasayı kesmez (marka 0) → beklemeye park eder.
    await page.goto('/#/spot?symbol=BTCUSDT')
    if (isMobile) {
      await page.getByRole('button', { name: 'Sat', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Emir ver' })).toBeVisible()
    } else {
      // Sekme (üstte) + gönder butonu (altta) aynı adı taşır.
      await page.getByRole('button', { name: 'Sat (Sell)' }).first().click()
    }
    const spotPanel = tradePanelRoot(page, isMobile)
    await spotPanel.locator('input[aria-label="Order price"]').fill('100')
    await spotPanel.locator('input[aria-label="Order amount"]').fill('100')
    await spotPanel.getByRole('button', { name: 'Sat (Sell)' }).last().click()
    await expect(page.getByText('Askıya alındı')).toBeVisible()
  })
})


