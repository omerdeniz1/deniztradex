import { expect, test } from '@playwright/test'
import {
  expectNoHorizontalOverflow,
  fundViaPromo,
  openVirtualTrade,
  registerViaUI,
  tradePanelRoot,
  uniqueUser,
} from './helpers'

/**
 * UI + responsive denetimleri (4 cihaz profilinde koşar).
 * - Kritik butonlar görünür, viewport içinde ve tıklanabilir.
 * - Sayfada yatay taşma yok.
 */
test.describe('Responsive + tıklanabilirlik', () => {
  test('piyasalar: arama + satırlar tüm ekranlarda çalışır', async ({ page }) => {
    const u = uniqueUser('e2emkt')
    await registerViaUI(page, u.username, u.email, u.password)
    await page.goto('/#/markets')
    const search = page.getByPlaceholder(/Coin ara/i)
    await expect(search).toBeVisible()
    await search.fill('BTC')
    await expect(page.getByText('BTC', { exact: true }).first()).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('spot işlem ekranı: panel kaymaz, emir akışı tıklanabilir', async ({
    page,
    isMobile,
  }) => {
    const u = uniqueUser('e2eui')
    await registerViaUI(page, u.username, u.email, u.password)
    await fundViaPromo(page)

    await page.goto('/#/spot?symbol=ENTES')

    if (isMobile) {
      // Mobil Al/Sat barı ekranda ve tıklanabilir.
      const buyTab = page.getByRole('button', { name: 'Al', exact: true })
      const sellTab = page.getByRole('button', { name: 'Sat', exact: true })
      for (const tab of [buyTab, sellTab]) {
        await expect(tab).toBeVisible()
        const box = await tab.boundingBox()
        expect(box, 'buton viewport dışında').not.toBeNull()
        const viewport = page.viewportSize()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1)
      }
      await buyTab.click()
      await expect(page.getByRole('dialog', { name: 'Emir ver' })).toBeVisible()
    }

    const panel = tradePanelRoot(page, isMobile)
    await expect(panel.getByText('Elindeki ENTES')).toBeVisible()
    const amount = panel.locator('input[aria-label="Order amount"]')
    await expect(amount).toBeVisible()
    await expect(amount).toBeEditable()
    await amount.fill('10')

    const submit = panel.getByRole('button', { name: 'ENTES Al' })
    await expect(submit).toBeVisible()
    await expect(submit).toBeEnabled()
    const box = await submit.boundingBox()
    expect(box, 'submit viewport dışında').not.toBeNull()
    await submit.click()
    await expect(page.getByText(/alındı/i).first()).toBeVisible()

    await expectNoHorizontalOverflow(page)
  })

  test('cüzdan: bölümler taşmaz, para yatır/çek butonları çalışır', async ({ page }) => {
    const u = uniqueUser('e2ewal')
    await registerViaUI(page, u.username, u.email, u.password)
    await page.goto('/#/wallet')

    await expect(page.getByText('Toplam Bakiye')).toBeVisible()
    const deposit = page.getByRole('button', { name: '+ Para Yatır' })
    const withdraw = page.getByRole('button', { name: '- Para Çek' })
    await expect(deposit).toBeVisible()
    await expect(withdraw).toBeVisible()
    await expect(deposit).toBeEnabled()
    await deposit.click()
    await expect(page.getByText('Para Yatırma', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Kapat' }).first().click()
    await expect(page.getByText('Para Yatırma', { exact: true })).toBeHidden()
    await expectNoHorizontalOverflow(page)
  })

  test('DNZ bölümü görünür, komisyon düğmesi tıklanabilir', async ({ page }) => {
    const u = uniqueUser('e2ednz')
    await registerViaUI(page, u.username, u.email, u.password)
    await page.goto('/#/wallet')
    await expect(page.getByText('DNZ Token')).toBeVisible()
    const toggle = page.locator('button[aria-label="Komisyonu DNZ ile öde"]')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expectNoHorizontalOverflow(page)
  })
})


