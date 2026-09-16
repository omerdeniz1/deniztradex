// Sanal Piyasa (AMM) headed testi — kayıt → promo → sanal alış → sanal satış.
// Calistirma: dev server ayaktayken `node e2e/virtual.mjs` (tarayıcı görünür).
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
mkdirSync('e2e/shots', { recursive: true })

const VIEWPORTS = [
  { name: 'v-desktop', width: 1440, height: 900, mobile: false },
  { name: 'v-mobile', width: 390, height: 844, mobile: true },
]

const results = []
const consoleErrors = []
const pageErrors = []

function log(vp, ok, step, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] [${vp}] ${step}${detail ? ` — ${detail}` : ''}`)
  results.push({ vp, ok, step })
}

async function runViewport(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  })
  const page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${vp.name}] ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => pageErrors.push(`[${vp.name}] ${String(e).slice(0, 300)}`))

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 15000 })

    // Kayıt ol
    const user = `vm${vp.name.replace('v-', '')}${Date.now().toString(36)}`.toLowerCase()
    await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
    await page.getByPlaceholder('örn. deniz_trader').fill(user)
    await page.getByPlaceholder('ornek@eposta.com').fill(`${user}@test.com`)
    const pw = page.getByPlaceholder('••••••••')
    await pw.first().fill('test1234')
    await pw.nth(1).fill('test1234')
    await page.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
    await page.getByText('Varlıklarınız').waitFor({ timeout: 8000 })
    log(vp.name, true, 'kayit-ol')

    // Promo ile bakiye yükle (sanal alış için sermaye)
    await page.locator('header button[aria-haspopup="menu"]').click()
    await page.getByRole('menuitem', { name: 'Cüzdan' }).click()
    await page.getByPlaceholder('Örn. dnztrd100').fill('dnztrd100')
    await page.getByRole('button', { name: 'Uygula' }).click()
    await page.getByText(/Tebrikler!/).waitFor({ timeout: 8000 })
    log(vp.name, true, 'promo +100 USDT')

    // Piyasalar → Sanal Piyasa sekmesi
    const moreBtn = page.getByRole('button', { name: /Piyasaları Gör|Tümünü gör/ }).first()
    if (await moreBtn.count()) await moreBtn.click()
    else await page.goto(`${BASE}#/markets`)
    await page.getByRole('tab', { name: 'Sanal Piyasa' }).click()
    for (const s of ['ENTES', 'V-XAU', 'V-XAG', 'RGC', 'MPRC', 'SVGC']) {
      await page.getByText(s, { exact: true }).first().waitFor({ timeout: 8000 })
    }
    log(vp.name, true, '6 sanal coin listede')
    await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-list.png` })

    // Sığ havuzda (SVGC) 100 USDT'lik alım: etki + hacim ölçülebilir olmalı
    await page.locator('tr', { hasText: 'SVGCOIN' }).click()
    await page.getByLabel('Alış tutarı (USDT)').fill('100')
    const preview = page.getByText(/Alacağın:/)
    await preview.waitFor({ timeout: 5000 })
    const previewText = await preview.innerText()
    const impactMatch = previewText.match(/Etki %([\d.,]+)/)
    const impactValue = impactMatch ? parseFloat(impactMatch[1].replace(/\./g, '').replace(',', '.')) : 0
    log(vp.name, impactValue > 0, 'fiyat etkisi onizlemede (slippage)', previewText.slice(0, 80))
    await page.getByRole('button', { name: 'SVGC Al' }).click()
    await page.getByText(/alındı\./).first().waitFor({ timeout: 8000 })
    log(vp.name, true, 'sanal alis (100 USDT → SVGC)')
    await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-buy.png` })

    // Hacim hücresi havuzun güncellendiğini kanıtlar
    const volumeCell = page.locator('tr', { hasText: 'SVGCOIN' }).locator('td').nth(3)
    const volumeText = (await volumeCell.innerText()).trim()
    log(vp.name, volumeText.includes('100'), 'hacim 24s guncellendi', volumeText)

    // Eldeki SVGC'den 1000 adet sat
    await page.getByRole('button', { name: 'Sat' }).click()
    await page.getByLabel('Satış adedi').fill('1000')
    await page.getByRole('button', { name: 'SVGC Sat' }).click()
    await page.getByText(/USDT alındı\./).waitFor({ timeout: 8000 })
    log(vp.name, true, 'sanal satis (SVGC → USDT)')
    await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-sell.png` })

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    log(vp.name, !overflow, 'yatay tasma yok (sanal piyasa)')
  } catch (e) {
    log(vp.name, false, 'ADIM HATASI', String(e).split('\n').slice(0, 3).join(' | '))
    await page.screenshot({ path: `e2e/shots/${vp.name}-FAIL.png` })
  } finally {
    await context.close()
  }
}

const browser = await chromium.launch({ headless: false, slowMo: 350 })
for (const vp of VIEWPORTS) await runViewport(browser, vp)
await browser.close()

console.log('\n--- console.error ---')
console.log(consoleErrors.length ? consoleErrors.join('\n') : '(temiz)')
console.log('--- pageerror ---')
console.log(pageErrors.length ? pageErrors.join('\n') : '(temiz)')
const failed = results.filter((r) => !r.ok)
console.log(`\nSONUÇ: ${results.length - failed.length}/${results.length} adım geçti`)
if (failed.length || pageErrors.length) process.exit(1)
