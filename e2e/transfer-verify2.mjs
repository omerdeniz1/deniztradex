import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e).slice(0, 150)))

async function register(user) {
  await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(800)
  // Zaten girişliyse önce çık.
  const menu = p.locator('header button[aria-haspopup="menu"]').last()
  if (await menu.count()) {
    await menu.click()
    await p.getByRole('menuitem', { name: 'Çıkış Yap' }).click()
    await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 8000 })
  }
  await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
  await p.getByPlaceholder('örn. deniz_trader').fill(user)
  await p.getByPlaceholder('ornek@eposta.com').fill(`${user}@test.com`)
  const pw = p.getByPlaceholder('••••••••')
  await pw.first().fill('test1234')
  await pw.nth(1).fill('test1234')
  await p.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
  await p.getByText('Varlıklarınız').waitFor({ timeout: 10000 })
}

const A = `rxa${Date.now().toString(36)}`
const B = `rxb${Date.now().toString(36)}`
await register(A)
await p.goto(`${BASE}/#/transfer`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1200)
const noA = ((await p.locator('span.font-mono.text-base').first().textContent()) || '').trim()
console.log('A wallet:', noA)

await register(B)
// B: promo fonlama
await p.locator('header button[aria-haspopup="menu"]').last().click()
await p.getByRole('menuitem', { name: 'Cüzdan' }).click()
await p.getByText('Promosyon Kodu Kullan').waitFor({ timeout: 8000 })
await p.getByPlaceholder('Örn. dnztrd100').fill('dnztrd100')
await p.getByRole('button', { name: 'Uygula' }).click()
await p.getByText(/Tebrikler!/).waitFor({ timeout: 8000 })
// B -> A 40 USDT
await p.goto(`${BASE}/#/transfer`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1200)
await p.getByLabel(/Alıcı/).fill(noA)
await p.getByRole('button', { name: 'Doğrula' }).click()
await p.getByText(A, { exact: false }).first().waitFor({ timeout: 8000 })
await p.getByLabel('Tutar').fill('40')
await p.getByRole('button', { name: 'Gönder' }).click()
await p.getByRole('button', { name: /Emin misin/ }).click()
await p.getByText(/gönderildi/).waitFor({ timeout: 8000 })
console.log('B->A 40 USDT: OK')

// A olarak giriş: bakiye + geçmiş doğrulaması
await p.locator('header button[aria-haspopup="menu"]').last().click()
await p.getByRole('menuitem', { name: 'Çıkış Yap' }).click()
await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 8000 })
// kullanıcı adı ile giriş (A'nın şifresi aynı)
await p.locator('form').getByRole('button', { name: 'Giriş Yap', exact: true }).click()
await p.getByPlaceholder('kullanıcı adı veya e-posta').fill(A)
await p.getByPlaceholder('••••••••').fill('test1234')
await p.locator('form').getByRole('button', { name: 'Giriş Yap', exact: true }).last().click()
await p.locator('header').waitFor({ timeout: 8000 }).catch(() => console.log('LOGIN-A FAILED'))
await p.goto(`${BASE}/#/transfer`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.screenshot({ path: 'e2e/shots/audit-in/v5-receiver.png' })
const incoming = await p.getByText(/Gelen/).count()
console.log('alıcı geçmiş satırı:', incoming > 0 ? 'VAR' : 'YOK')
console.log('pageerrors:', errs.length ? errs.join(' | ') : '(temiz)')
await b.close()
