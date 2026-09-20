import { expect, type Page } from '@playwright/test'

/**
 * E2E ortak yardımcıları (yerel backend — deterministik, ağsız).
 * Her test fresh browser context ile başlar (localStorage boş).
 */

export function uniqueUser(prefix = 'e2e'): { username: string; email: string; password: string } {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const username = `${prefix}_${stamp}`.toLowerCase()
  return { username, email: `${username}@e2e.test`, password: 'Test1234' }
}

/** UI üzerinden kayıt olur, oturumun kurulmasını bekler. */
export async function registerViaUI(page: Page, username: string, email: string, password: string) {
  await page.goto('/#/')
  await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
  await page.getByPlaceholder('örn. deniz_trader').fill(username)
  await page.getByPlaceholder('ornek@eposta.com').fill(email)
  const passwords = page.locator('input[type="password"]')
  await passwords.nth(0).fill(password)
  await passwords.nth(1).fill(password)
  await page.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
  // Kayıt formu kapandı + oturum localStorage'a yazıldı.
  await expect(page.getByRole('button', { name: 'Kayıt Ol ve Başla' })).toBeHidden()
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem('deniztradx_session')), {
      message: 'oturum kurulamadı',
    })
    .not.toBeNull()
}

/** Cüzdan → promosyon koduyla 100 USDT yükler (kart akışsız fonlama). */
export async function fundViaPromo(page: Page, code = 'deniz100') {
  await page.goto('/#/wallet')
  await page.getByPlaceholder('Örn. dnztrd100').fill(code)
  await page.getByRole('button', { name: 'Uygula' }).click()
  await expect(page.getByText('Tebrikler!')).toBeVisible()
}

/** localStorage cüzdan blob'unu okur (milimetrik bakiye doğrulaması için). */
export async function readWallet(page: Page): Promise<{ balance: number; spotBalances: Record<string, number> }> {
  return page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('deniztradx_session') ?? '{}') as { id?: string }
    const blob = JSON.parse(
      localStorage.getItem(`deniztradx_wallet_${session.id ?? ''}`) ?? '{}',
    ) as { state?: { balance?: number; spotBalances?: Record<string, number> } }
    return { balance: blob.state?.balance ?? NaN, spotBalances: blob.state?.spotBalances ?? {} }
  })
}

/** Sanal holding defterini okur (cihaz-ortak yerel defter). */
export async function readVirtualHoldings(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem('deniztradx_virtual_holdings') ?? '{}') ?? {}) as Record<string, number>
    } catch {
      return {}
    }
  })
}

/** Sanal işlem ekranını açar (mobilde önce yön butonuyla sheet açılır). */
export async function openVirtualTrade(page: Page, symbol: string, isMobile: boolean, side: 'buy' | 'sell') {
  await page.goto(`/#/spot?symbol=${symbol}`)
  if (isMobile) {
    // Mobil: form yalnızca bottom sheet içindedir.
    const dir = page.getByRole('button', { name: side === 'buy' ? 'Al' : 'Sat', exact: true })
    await dir.scrollIntoViewIfNeeded()
    await dir.click()
    await expect(page.getByRole('dialog', { name: 'Emir ver' })).toBeVisible()
  } else {
    await page.getByRole('button', { name: side === 'buy' ? 'Al (Buy)' : 'Sat (Sell)' }).click()
  }
  await expect(tradePanelRoot(page, isMobile).getByText(`Elindeki ${symbol}`)).toBeVisible()
}

/**
 * Aktif işlem paneli kökü: mobilde bottom sheet diyaloğu, masaüstünde
 * sağ aside. (İkisi de DOM'da olabilir — biri gizlidir.)
 */
export function tradePanelRoot(page: Page, isMobile: boolean) {
  return isMobile
    ? page.getByRole('dialog', { name: 'Emir ver' })
    : page.locator('aside')
}

/** Sayfada yatay taşma olmadığını doğrular (responsive kuralı). */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(overflow.scroll, 'yatay taşma var').toBeLessThanOrEqual(overflow.client + 1)
}

