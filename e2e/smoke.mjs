// DenizTradeX headed smoke testi — gerçek kullanıcı yolculuğu.
// Calistirma: dev server ayaktayken `node e2e/smoke.mjs`
// Tarayıcı GÖRÜNÜR açılır (headless: false) + yavaşlatılmış adımlar.
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
const SHOTS = 'e2e/shots'
mkdirSync(SHOTS, { recursive: true })

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'tablet', width: 768, height: 1024, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'small', width: 360, height: 740, mobile: true },
]

const results = []
const consoleErrors = []
const pageErrors = []

function log(vp, ok, step, detail = '') {
  const icon = ok ? 'PASS' : 'FAIL'
  console.log(`[${icon}] [${vp}] ${step}${detail ? ` — ${detail}` : ''}`)
  results.push({ vp, ok, step, detail })
}

async function shot(page, vp, name) {
  await page.screenshot({ path: `${SHOTS}/${vp}-${name}.png` })
}

async function noXOverflow(page, vp, where) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  )
  log(vp, !overflow, `yatay tasma yok (${where})`, overflow ? 'TASMA VAR' : '')
}

async function register(page, vp, tag) {
  const user = `pw${tag}${Date.now().toString(36)}`.toLowerCase()
  const email = `${user}@test.com`
  const pass = 'test1234'
  await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
  await page.getByPlaceholder('örn. deniz_trader').fill(user)
  await page.getByPlaceholder('ornek@eposta.com').fill(email)
  const pwFields = page.getByPlaceholder('••••••••')
  await pwFields.first().fill(pass)
  await pwFields.nth(1).fill(pass)
  await page.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
  await page.getByText('Varlıklarınız').waitFor({ timeout: 8000 })
  log(vp, true, 'kayit-ol + giris', user)
  await shot(page, vp, 'home')
  return { user, email, pass }
}

async function login(page, vp, identifier, pass) {
  await page.getByPlaceholder('kullanıcı adı veya e-posta').fill(identifier)
  await page.getByPlaceholder('••••••••').fill(pass)
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).last().click()
  // Giris ayni rotada kalabilir (HashRouter) — kabuk (header) yeterli kanıt.
  await page.locator('header').waitFor({ timeout: 8000 })
  await page.goto(`${BASE}#/`)
  await page.getByText('Varlıklarınız').waitFor({ timeout: 8000 })
  log(vp, true, 'cikis-sonrasi yeni sifreyle giris')
}

async function openUserMenu(page) {
  await page.locator('header button[aria-haspopup="menu"]').click()
}

async function redeemPromo(page, vp) {
  await openUserMenu(page)
  await page.getByRole('menuitem', { name: 'Cüzdan' }).click()
  await page.getByText('Promosyon Kodu Kullan').waitFor({ timeout: 8000 })
  await page.getByPlaceholder('Örn. dnztrd100').fill('dnztrd100')
  await page.getByRole('button', { name: 'Uygula' }).click()
  await page.getByText(/Tebrikler!/, { exact: false }).waitFor({ timeout: 8000 })
  log(vp, true, 'promosyon kodu +100 USDT')
  await shot(page, vp, 'wallet')
}

async function marketsSearch(page, vp) {
  const moreBtn = page.getByRole('button', { name: /Piyasaları Gör|Tümünü gör/ }).first()
  if (await moreBtn.count()) await moreBtn.click()
  else await page.goto(`${BASE}#/markets`)
  await page.getByPlaceholder(/Coin ara/).fill('altın')
  await page.getByText('V-XAU', { exact: true }).first().waitFor({ timeout: 10000 })
  log(vp, true, 'piyasa arama (altın → V-XAU, sanal)')
  await shot(page, vp, 'markets')
  await page.getByPlaceholder(/Coin ara/).fill('')
}

async function spotTrade(page, vp, mobile) {
  if (mobile) {
    await page.getByRole('link', { name: 'Al-Sat' }).click()
    await page.getByRole('button', { name: 'Al', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Emir ver' })
    await dialog.waitFor({ timeout: 8000 })
    await shot(page, vp, 'sheet')
    await dialog.getByLabel('Order type').click()
    await dialog.getByRole('option', { name: 'Piyasa' }).click()
    await dialog.getByLabel('Order amount').fill('50')
    await dialog.getByRole('button', { name: 'Al (Buy)' }).last().click()
    await page.getByText(/Emir gönderildi/).last().waitFor({ timeout: 8000 })
    await dialog.waitFor({ state: 'hidden', timeout: 8000 })
    log(vp, true, 'mobil sheet ile spot alis (50 USDT, piyasa)')
  } else {
    await page.getByRole('link', { name: 'Al-Sat' }).click()
    await page.getByLabel('Order type').click()
    await page.getByRole('option', { name: 'Piyasa' }).click()
    await page.getByLabel('Order amount').fill('50')
    await page.getByRole('button', { name: 'Al (Buy)' }).last().click()
    await page.getByText(/Emir gönderildi/).last().waitFor({ timeout: 8000 })
    log(vp, true, 'masaüstü spot alis (50 USDT, piyasa)')
  }
  await shot(page, vp, 'spot')
}

async function futuresTrade(page, vp, mobile) {
  if (mobile) {
    await page.getByRole('link', { name: 'Vadeli' }).click()
    await page.getByRole('button', { name: 'Long', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Emir ver' })
    await dialog.waitFor({ timeout: 8000 })
    // Marjin modu: Çapraz'a tek tıkla geç
    await dialog.getByRole('button', { name: 'Çapraz' }).click()
    const pressed = await dialog.getByRole('button', { name: 'Çapraz' }).getAttribute('aria-pressed')
    log(vp, pressed === 'true', 'marjin modu Capraz secimi', `aria-pressed=${pressed}`)
    await dialog.getByLabel('Order type').click()
    await dialog.getByRole('option', { name: 'Piyasa' }).click()
    await dialog.getByLabel('Order amount').fill('20')
    await dialog.getByRole('button', { name: 'Buy / Long' }).click()
    await page.getByText(/Emir gönderildi/).last().waitFor({ timeout: 8000 })
    log(vp, true, 'mobil vadeli long (20 USDT, capraz)')
  } else {
    await page.getByRole('link', { name: 'Vadeli' }).click()
    await page.getByRole('button', { name: 'Çapraz' }).click()
    await page.getByLabel('Order type').click()
    await page.getByRole('option', { name: 'Piyasa' }).click()
    await page.getByLabel('Order amount').fill('20')
    await page.getByRole('button', { name: 'Buy / Long', exact: true }).click()
    await page.getByText(/Emir gönderildi/).last().waitFor({ timeout: 8000 })
    const pos = await page.getByText('BTCUSDT', { exact: true }).count()
    log(vp, pos > 0, 'masaüstü vadeli long + pozisyon listede', `eslesme=${pos}`)
  }
  await shot(page, vp, 'futures')
}

async function forumPost(page, vp, tag) {
  const nav = page.getByRole('link', { name: 'Forum' })
  if (await nav.count()) await nav.click()
  else {
    await page.getByRole('button', { name: 'Menü' }).click()
    await page.getByRole('menuitem', { name: 'Forum' }).click()
  }
  const text = `e2e ${tag} ${Date.now().toString(36)} merhaba forum`
  await page.getByLabel('Yeni gönderi').fill(text)
  await page.getByRole('button', { name: 'Paylaş' }).click()
  await page.getByText(text).waitFor({ timeout: 10000 })
  log(vp, true, 'forum paylasimi gorunur')
  await shot(page, vp, 'forum')
}

async function leaderboard(page, vp) {
  const nav = page.getByRole('link', { name: 'Sıralama' })
  if (await nav.count()) await nav.click()
  else {
    await page.getByRole('button', { name: 'Menü' }).click()
    await page.getByRole('menuitem', { name: 'Sıralama' }).click()
  }
  await page.waitForURL('**#/leaderboard', { timeout: 8000 })
  await page.getByRole('heading', { name: 'Sıralama' }).waitFor({ timeout: 8000 })
  // Çevrimdışı backend yoksa hata bandı beklenir, canlıysa tablo.
  const table = await page.locator('table').count()
  const retry = await page.getByText('Tekrar dene').count()
  log(vp, table > 0 || retry > 0, 'siralama icerik/hata durumu', `tablo=${table} hata=${retry}`)
  await shot(page, vp, 'leaderboard')
}

async function changePassword(page, vp) {
  await openUserMenu(page)
  await page.getByRole('menuitem', { name: 'Ayarlar' }).click()
  await page.getByRole('button', { name: 'Şifre Değiştir' }).click()
  await page.getByLabel('Mevcut şifre').fill('test1234')
  await page.getByLabel('Yeni şifre (en az 6 karakter)').fill('yeni5678')
  await page.getByLabel('Yeni şifre (tekrar)').fill('yeni5678')
  await page.getByRole('button', { name: 'Şifreyi Güncelle' }).click()
  await page.getByText(/Şifren güncellendi/).waitFor({ timeout: 8000 })
  log(vp, true, 'sifre degistirme')
  await shot(page, vp, 'settings')
}

async function logout(page, vp) {
  await openUserMenu(page)
  await page.getByRole('menuitem', { name: 'Çıkış Yap' }).click()
  await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 8000 })
  log(vp, true, 'cikis')
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
    await shot(page, vp.name, 'auth')
    await noXOverflow(page, vp.name, 'auth')

    const creds = await register(page, vp.name, vp.name.slice(0, 2))
    await noXOverflow(page, vp.name, 'home')

    if (vp.mobile) {
      const nav = page.getByRole('navigation', { name: 'Mobil gezinme' })
      log(vp.name, await nav.count() === 1, 'mobil alt menu gorunur')
    }

    await redeemPromo(page, vp.name)
    await noXOverflow(page, vp.name, 'wallet')
    await marketsSearch(page, vp.name)
    await noXOverflow(page, vp.name, 'markets')
    await spotTrade(page, vp.name, vp.mobile)
    await noXOverflow(page, vp.name, 'spot')
    await futuresTrade(page, vp.name, vp.mobile)
    await noXOverflow(page, vp.name, 'futures')
    await forumPost(page, vp.name, vp.name)
    await noXOverflow(page, vp.name, 'forum')
    await leaderboard(page, vp.name)
    await noXOverflow(page, vp.name, 'leaderboard')
    await changePassword(page, vp.name)
    await noXOverflow(page, vp.name, 'settings')
    await logout(page, vp.name)
    await login(page, vp.name, creds.email, 'yeni5678')
    await shot(page, vp.name, 'relogin')
  } catch (e) {
    log(vp.name, false, 'ADIM HATASI', String(e).split('\n').slice(0, 3).join(' | '))
    await shot(page, vp.name, 'FAIL')
  } finally {
    await context.close()
  }
}

const browser = await chromium.launch({ headless: false, slowMo: 350 })
for (const vp of VIEWPORTS) await runViewport(browser, vp)
await browser.close()

console.log('\n--- console.error kayıtları ---')
console.log(consoleErrors.length ? consoleErrors.join('\n') : '(temiz)')
console.log('--- pageerror kayıtları ---')
console.log(pageErrors.length ? pageErrors.join('\n') : '(temiz)')
const failed = results.filter((r) => !r.ok)
console.log(`\nSONUÇ: ${results.length - failed.length}/${results.length} adım geçti`)
if (failed.length || pageErrors.length) {
  console.log('KALAN SORUNLAR:')
  failed.forEach((f) => console.log(` - [${f.vp}] ${f.step} ${f.detail}`))
  process.exit(1)
}
