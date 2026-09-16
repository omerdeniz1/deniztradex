// Sanal Piyasa (birleşik) headed testi — kayıt → promo → piyasalar (rozetsiz
// tek tablo) → spot ekranında sanal grafik + AMM al/sat.
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

    // Promo ile bakiye yükle
    await page.locator('header button[aria-haspopup="menu"]').click()
    await page.getByRole('menuitem', { name: 'Cüzdan' }).click()
    await page.getByPlaceholder('Örn. dnztrd100').fill('dnztrd100')
    await page.getByRole('button', { name: 'Uygula' }).click()
    await page.getByText(/Tebrikler!/).waitFor({ timeout: 8000 })
    log(vp.name, true, 'promo +100 USDT')

    // Piyasalar: tek birleşik tablo — sanal satırlar rozetsiz, sekme yok
    const moreBtn = page.getByRole('button', { name: /Piyasaları Gör|Tümünü gör/ }).first()
    if (await moreBtn.count()) await moreBtn.click()
    else await page.goto(`${BASE}#/markets`)
    for (const s of ['ENTES', 'V-XAU', 'V-XAG', 'RGC', 'MPRC', 'SVGC']) {
      await page.getByText(s, { exact: true }).first().waitFor({ timeout: 8000 })
    }
    const hasVirtualTab = await page.getByRole('tab', { name: 'Sanal Piyasa' }).count()
    const hasBadge = await page.getByText('Emtia', { exact: true }).count()
    log(vp.name, hasVirtualTab === 0 && hasBadge === 0, 'tek tablo, rozet/sekme ayrimi yok')
    // Gerçek emtia (PAXG/XAUT) listede olmamalı
    const paxg = await page.getByText('PAXG', { exact: true }).count()
    log(vp.name, paxg === 0, 'gercek emtia listede yok')
    await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-list.png` })

    // Al-Sat ekranı (sanal): canlı sıralama satırı her saniye oynattığı
    // için satır tıklaması flake oluyor; satır→spot yönlendirmesi birim
    // testte kanıtlı (MarketsPage.test), burada rotaya doğrudan gidiliyor.
    await page.goto(`${BASE}#/spot?symbol=SVGC`)
    await page.waitForURL('**#/spot?symbol=SVGC', { timeout: 8000 })
    // Grafik kendi mumlarımızdan çizildi (canvas var, hata bandı yok)
    await page.locator('canvas').first().waitFor({ timeout: 15000 })
    const marketFail = await page.getByText('Failed to load market data').count()
    log(vp.name, marketFail === 0, 'sanal grafik cizildi (Binance hatasi yok)')
    await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-chart.png` })

    if (vp.mobile) {
      // Mobil: sheet içinde AMM paneli
      await page.getByRole('button', { name: 'Al', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Emir ver' })
      await dialog.waitFor({ timeout: 8000 })
      await dialog.getByLabel('Alış tutarı (USDT)').fill('100')
      const preview = dialog.getByText(/Alacağın/)
      await preview.waitFor({ timeout: 15000 })
      await dialog.getByRole('button', { name: 'SVGC Al' }).click()
      await page.getByText(/alındı\./).first().waitFor({ timeout: 8000 })
      log(vp.name, true, 'mobil sheet sanal alis (100 USDT → SVGC)')
      await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-buy.png` })

      // Satış için sheet'i kapatıp yeniden aç, Sat tarafına geç
      await dialog.getByRole('button', { name: 'Kapat' }).click()
      await page.getByRole('button', { name: 'Al', exact: true }).click()
      const dialog2 = page.getByRole('dialog', { name: 'Emir ver' })
      await dialog2.waitFor({ timeout: 8000 })
      await dialog2.getByRole('button', { name: 'Sat (Sell)' }).click()
      await dialog2.getByLabel('Satış adedi').fill('1000')
      await dialog2.getByRole('button', { name: 'SVGC Sat' }).click()
      await page.getByText(/USDT alındı\./).waitFor({ timeout: 8000 })
      log(vp.name, true, 'mobil sheet sanal satis (SVGC → USDT)')
    } else {
      // Masaüstü: yan AMM paneli
    await page.getByLabel('Alış tutarı (USDT)').fill('100')
    await page.getByText(/Alacağın/).waitFor({ timeout: 15000 })
      const panelText = await page.locator('aside').innerText()
      const m = panelText.match(/etkisi\s*%([\d.,]+)/i)
      const impact = m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) : 0
      log(vp.name, impact > 0, 'fiyat etkisi onizlemede', (m?.[0] ?? 'yok'))
      await page.getByRole('button', { name: 'SVGC Al' }).click()
      await page.getByText(/alındı\./).first().waitFor({ timeout: 8000 })
      log(vp.name, true, 'sanal alis (100 USDT → SVGC)')
      await page.screenshot({ path: `e2e/shots/${vp.name}-virtual-buy.png` })

      // Satış: panele dön, Sat tarafı
      await page.getByRole('button', { name: 'Sat (Sell)' }).first().click()
      await page.getByLabel('Satış adedi').fill('1000')
      await page.getByRole('button', { name: 'SVGC Sat' }).click()
      await page.getByText(/USDT alındı\./).waitFor({ timeout: 8000 })
      log(vp.name, true, 'sanal satis (SVGC → USDT)')
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    log(vp.name, !overflow, 'yatay tasma yok')
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
