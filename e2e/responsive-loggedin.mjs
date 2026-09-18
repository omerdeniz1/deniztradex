// Girişli responsive denetim: kayıt → promo → spot alım → tüm rotalar.
// Başsız Chromium, masaüstü / tablet / telefon.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
const SHOTS = 'e2e/shots/audit-in'
mkdirSync(SHOTS, { recursive: true })

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'tablet', width: 768, height: 1024, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]

const ROUTES = ['#/', '#/markets', '#/spot?symbol=BTCUSDT', '#/spot?symbol=ENTES', '#/futures?symbol=BTCUSDT', '#/forum', '#/wallet', '#/leaderboard', '#/settings', '#/events']
const results = []
const log = (vp, route, kind, ok, detail = '') => {
  results.push({ vp, route, kind, ok, detail })
  if (!ok) console.log(` - [${vp}] [${route}] [${kind}] ${detail}`)
}

async function setupUser(page, vp) {
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 15000 })
  const user = `audit${vp}${Date.now().toString(36)}`.toLowerCase()
  await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
  await page.getByPlaceholder('örn. deniz_trader').fill(user)
  await page.getByPlaceholder('ornek@eposta.com').fill(`${user}@test.com`)
  const pw = page.getByPlaceholder('••••••••')
  await pw.first().fill('test1234')
  await pw.nth(1).fill('test1234')
  await page.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
  await page.getByText('Varlıklarınız').waitFor({ timeout: 10000 })
  // Promo + spot alım (cüzdan/varlıklar dolsun, ort. maliyet görünsün).
  // Kullanıcı menüsü kullanıcı adını taşır (hamburgerden ayrışır).
  const menuBtn = page.getByRole('button', { name: user })
  if (await menuBtn.count()) {
    await menuBtn.click()
    await page.getByRole('menuitem', { name: 'Cüzdan' }).click()
    await page.getByText('Promosyon Kodu Kullan').waitFor({ timeout: 8000 })
    await page.getByPlaceholder('Örn. dnztrd100').fill('dnztrd100')
    await page.getByRole('button', { name: 'Uygula' }).click()
    await page.getByText(/Tebrikler!/, { exact: false }).waitFor({ timeout: 8000 }).catch(() => {})
  }
  // Spot alım (masaüstü panelden; mobilde sheet üzerinden)
  await page.goto(`${BASE}/#/spot?symbol=BTCUSDT`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const isMobileBtn = await page.getByRole('button', { name: 'Al', exact: true }).count()
  if (isMobileBtn > 0) {
    await page.getByRole('button', { name: 'Al', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Emir ver' })
    await dialog.waitFor({ timeout: 8000 })
    // Deterministik: limit emir (piyasa fiyatı sandbox'ta dalgalı).
    // Varsayılan tip zaten Limit — fiyat + tutar girilir.
    await dialog.getByLabel('Order price').fill('70000')
    await dialog.getByLabel('Order amount').fill('50')
    await page.screenshot({ path: `${SHOTS}/${vp}-sheet-al.png` })
    await dialog.getByRole('button', { name: 'Al (Buy)' }).last().click()
    await page.getByText(/Emir gönderildi|Askıya alındı/).last().waitFor({ timeout: 8000 }).catch(() => {})
    await dialog.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
    // Sat sheet'i de aç (Sat'ta Sat menüsü mü?)
    await page.getByRole('button', { name: 'Sat', exact: true }).click()
    await dialog.waitFor({ timeout: 8000 })
    await page.screenshot({ path: `${SHOTS}/${vp}-sheet-sat.png` })
    await page.keyboard.press('Escape').catch(() => {})
    await dialog.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
  } else {
    await page.getByLabel('Order type').click()
    await page.getByRole('option', { name: 'Piyasa' }).click()
    await page.getByLabel('Order amount').fill('50')
    await page.getByRole('button', { name: 'Al (Buy)' }).last().click()
    await page.getByText(/Emir gönderildi/).last().waitFor({ timeout: 8000 }).catch(() => {})
  }
  // Forum gönderisi (akış dolsun)
  await page.goto(`${BASE}/#/forum`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const draft = page.getByLabel('Yeni gönderi')
  if (await draft.count()) {
    await draft.fill(`denetim gönderisi ${vp} ${Date.now().toString(36)} piyasalar güzel görünüyor`)
    await page.getByRole('button', { name: 'Paylaş' }).click()
    await page.waitForTimeout(1500)
  }
}

async function auditRoute(page, vp, route) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/${vp}-${route.replace(/[#/?=&]/g, '_')}.png` })

  const overflow = await page.evaluate(() => {
    const xOverflow = document.documentElement.scrollWidth > window.innerWidth + 1
    const bad = []
    if (xOverflow) {
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1)) {
          bad.push(`${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal === undefined ? el.className : '').split(' ').slice(0, 3).join('.')} l=${Math.round(r.left)} r=${Math.round(r.right)} :: ${(el.textContent || '').trim().slice(0, 50)}`)
        }
      })
    }
    return { xOverflow, bad: bad.slice(0, 12) }
  })
  log(vp, route, 'x-overflow', !overflow.xOverflow, overflow.xOverflow ? overflow.bad.join(' || ') : '')

  const overlaps = await page.evaluate(() => {
    const els = [...document.querySelectorAll('main button, main a, main input, main table, header button, header a, nav button, nav a')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        const st = getComputedStyle(el)
        return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight && st.visibility !== 'hidden' && st.display !== 'none'
      })
      .slice(0, 220)
    const hits = []
    for (let i = 0; i < els.length && hits.length < 10; i++) {
      for (let j = i + 1; j < els.length && hits.length < 10; j++) {
        const a = els[i].getBoundingClientRect()
        const b = els[j].getBoundingClientRect()
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (ix > 4 && iy > 4) {
          if (els[i].contains(els[j]) || els[j].contains(els[i])) continue
          const t = (el) => `${el.tagName.toLowerCase()}(${(el.textContent || '').trim().slice(0, 25)})`
          hits.push(`${t(els[i])} <> ${t(els[j])}`)
        }
      }
    }
    return hits
  })
  log(vp, route, 'overlap', overlaps.length === 0, overlaps.join(' || '))
}

const browser = await chromium.launch({ headless: true })
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => log(vp.name, '*', 'pageerror', false, String(e).slice(0, 200)))
  try {
    await setupUser(page, vp.name)
    for (const route of ROUTES) {
      try { await auditRoute(page, vp.name, route) } catch (e) { log(vp.name, route, 'audit-crash', false, String(e).split('\n')[0]) }
    }
  } catch (e) {
    log(vp.name, '*', 'setup-crash', false, String(e).split('\n').slice(0, 3).join(' | '))
    await page.screenshot({ path: `${SHOTS}/${vp.name}-FAIL.png` }).catch(() => {})
  }
  await context.close()
}
await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\nGIRISLI DENETIM: ${results.length - failed.length}/${results.length} kontrol geçti`)
writeFileSync(`${SHOTS}/report.json`, JSON.stringify(results, null, 2))
if (failed.length) process.exit(1)
