import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5173'
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e).slice(0, 150)))

const U = `kst${Date.now().toString(36)}`
await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 15000 })
await p.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
await p.getByPlaceholder('örn. deniz_trader').fill(U)
await p.getByPlaceholder('ornek@eposta.com').fill(`${U}@test.com`)
const pw = p.getByPlaceholder('••••••••')
await pw.first().fill('test1234')
await pw.nth(1).fill('test1234')
await p.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
await p.getByText('Varlıklarınız').waitFor({ timeout: 10000 })

// Kartla yatırma dene → kısıt mesajı beklenir.
await p.getByRole('button', { name: '+ Para Yatır' }).click()
await p.waitForTimeout(1200)
await p.getByPlaceholder('XXXX XXXX XXXX XXXX').fill('4111 1111 1111 1111')
await p.getByPlaceholder('AD SOYAD').fill('TEST USER')
await p.getByPlaceholder('AA/YY').fill('12/30')
await p.getByPlaceholder('•••').fill('123')
await p.getByPlaceholder('örn. 34000').fill('34000')
await p.waitForTimeout(1500)
await p.getByRole('button', { name: /USDT Yatır|Para Yatır/ }).last().click()
await p.waitForTimeout(1500)
const blocked = await p.getByText(/kısıtlanmış/i).count()
console.log('kısıt mesajı:', blocked > 0 ? 'VAR (beklendiği gibi)' : 'YOK (HATA!)')
await p.screenshot({ path: 'e2e/shots/audit-in/v5-deposit-blocked.png' })
// Ana sayfa tabloları sanalsız çökmüyor mu?
await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2000)
await p.screenshot({ path: 'e2e/shots/audit-in/v5-home.png' })
console.log('pageerrors:', errs.length ? errs.join(' | ') : '(temiz)')
await b.close()
