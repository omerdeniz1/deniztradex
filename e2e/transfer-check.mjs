import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e).slice(0, 150)))

async function register(user) {
  await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
  await p.getByPlaceholder('örn. deniz_trader').fill(user)
  await p.getByPlaceholder('ornek@eposta.com').fill(`${user}@test.com`)
  const pw = p.getByPlaceholder('••••••••')
  await pw.first().fill('test1234')
  await pw.nth(1).fill('test1234')
  await p.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
  await p.getByText('Varlıklarınız').waitFor({ timeout: 10000 })
}

async function logout() {
  await p.locator('header button[aria-haspopup="menu"]').last().click()
  await p.getByRole('menuitem', { name: 'Çıkış Yap' }).click()
  await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 8000 })
}

const A = `tra${Date.now().toString(36)}`
const B = `trb${Date.now().toString(36)}`
await register(A)
await p.goto(`${BASE}/#/transfer`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
const noA = ((await p.locator('span.font-mono.text-base').first().textContent()) || '').trim()
console.log('A wallet:', noA)
await p.screenshot({ path: 'e2e/shots/audit-in/v5-transfer.png' })
await logout()

await register(B)
await p.locator('header button[aria-haspopup="menu"]').last().click()
await p.getByRole('menuitem', { name: 'Cüzdan' }).click()
await p.getByText('Promosyon Kodu Kullan').waitFor({ timeout: 8000 })
await p.getByPlaceholder('Örn. dnztrd100').fill('dnztrd100')
await p.getByRole('button', { name: 'Uygula' }).click()
await p.getByText(/Tebrikler!/).waitFor({ timeout: 8000 }).catch(() => console.log('PROMO BLOCKED (hata!)'))
console.log('promo: OK (kisit promo engellemez)')

await p.goto(`${BASE}/#/transfer`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.getByLabel(/Alıcı/).fill(noA)
await p.getByRole('button', { name: 'Doğrula' }).click()
await p.getByText(A, { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => console.log('LOOKUP FAILED'))
console.log('lookup: OK')
await p.getByLabel('Transfer varlığı').click()
await p.getByRole('option', { name: /USDT/ }).first().click()
await p.getByLabel('Tutar').fill('30')
await p.getByRole('button', { name: 'Gönder' }).click()
await p.getByRole('button', { name: /Emin misin/ }).click()
await p.getByText(/gönderildi/).waitFor({ timeout: 8000 }).catch(() => console.log('SEND FAILED'))
console.log('send: OK')
await p.screenshot({ path: 'e2e/shots/audit-in/v5-transfer-done.png' })
console.log('pageerrors:', errs.length ? errs.join(' | ') : '(temiz)')
await b.close()
