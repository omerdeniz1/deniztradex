// Responsive denetim: masaüstü / tablet / telefon — başsız Chromium.
// Calistirma: dev server ayaktayken `node e2e/responsive-audit.mjs`
// Her rotada: yatay taşma + üst üste binen kutular + ekran görüntüsü.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
const SHOTS = 'e2e/shots/audit'
mkdirSync(SHOTS, { recursive: true })

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'tablet', width: 768, height: 1024, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'small', width: 360, height: 740, mobile: true },
]

const ROUTES = ['#/', '#/markets', '#/spot?symbol=BTCUSDT', '#/spot?symbol=ENTES', '#/futures?symbol=BTCUSDT', '#/forum', '#/wallet', '#/leaderboard', '#/settings', '#/events']

const results = []

async function auditPage(page, vp, route) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const label = `${vp.name} ${route}`
  // Ekran görüntüsü
  const shotName = `${SHOTS}/${vp.name}-${route.replace(/[#/?=&]/g, '_')}.png`
  await page.screenshot({ path: shotName, fullPage: false })

  // 1) Yatay taşma
  const overflow = await page.evaluate(() => {
    const de = document.documentElement
    const xOverflow = de.scrollWidth > window.innerWidth + 1
    const bad = []
    if (xOverflow) {
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1)) {
          const cls = (el.className && el.className.baseVal === undefined ? String(el.className) : '').split(' ').slice(0, 4).join('.')
          bad.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} l=${Math.round(r.left)} r=${Math.round(r.right)} w=${Math.round(r.width)} :: ${(el.textContent || '').trim().slice(0, 60)}`)
        }
      })
    }
    return { xOverflow, docW: de.scrollWidth, winW: window.innerWidth, bad: bad.slice(0, 15) }
  })
  results.push({ vp: vp.name, route, kind: 'x-overflow', ok: !overflow.xOverflow, detail: overflow.xOverflow ? `doc=${overflow.docW} win=${overflow.winW} | ${overflow.bad.join(' || ')}` : '' })

  // 2) Üst üste binme: görünür kardeş kutuların kesişimi (anlamlı alanlar)
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
        // Aynı satırdaki yan-yana öğeler dokunabilir; gerçek binme = alan kesişimi
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (ix > 4 && iy > 4) {
          // İç içe (ebeveyn-çocuk) sayılmaz
          if (els[i].contains(els[j]) || els[j].contains(els[i])) continue
          const t = (el) => `${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal === undefined ? el.className : '').split(' ').slice(0, 2).join('.')}(${(el.textContent || '').trim().slice(0, 25)})`
          hits.push(`${t(els[i])} <> ${t(els[j])} ix=${Math.round(ix)} iy=${Math.round(iy)}`)
        }
      }
    }
    return hits
  })
  results.push({ vp: vp.name, route, kind: 'overlap', ok: overlaps.length === 0, detail: overlaps.join(' || ') })
}

const browser = await chromium.launch({ headless: true })
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => results.push({ vp: vp.name, route: '*', kind: 'pageerror', ok: false, detail: String(e).slice(0, 200) }))
  for (const route of ROUTES) {
    try {
      await auditPage(page, vp, route)
    } catch (e) {
      results.push({ vp: vp.name, route, kind: 'audit-crash', ok: false, detail: String(e).split('\n')[0] })
    }
  }
  await context.close()
}
await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\nDENETIM: ${results.length - failed.length}/${results.length} kontrol geçti`)
for (const f of failed) console.log(` - [${f.vp}] [${f.route}] [${f.kind}] ${f.detail}`)
writeFileSync(`${SHOTS}/report.json`, JSON.stringify(results, null, 2))
if (failed.length) process.exit(1)
