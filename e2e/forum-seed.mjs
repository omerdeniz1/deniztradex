// Forum demo tohumlama (GEÇİCİ): 4 yeni kripto personasına forumdan mesaj
// yazdırır. Sistem Temp altındaki kalıcı profilde saklanır; sıfırlamak için
// o klasör silinir (yol çalışınca konsola yazılır).
// Calistirma: dev server ayaktayken `node e2e/forum-seed.mjs` (görünür).
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const PROFILE_DIR = join(tmpdir(), 'dt-forum-seed-profile')

const BASE = 'http://localhost:5173'
mkdirSync('e2e/shots', { recursive: true })

const PERSONAS = [
  {
    username: 'ENTES',
    email: 'entes@test.com',
    text: 'ENTES burada! Kral coin selam veriyor. 50M USDT havuz derinliğiyle en sakin taht benim. Bakalım kimler uzun vadeci?',
  },
  {
    username: 'RGC',
    email: 'rgc@test.com',
    text: 'RGCOIN tayfası toplanın! 0.01 USDT fiyat, orta-yüksek volatilite — hareket sevenlere duyurulur. Hedef ay!',
  },
  {
    username: 'MPRC',
    email: 'mprc@test.com',
    text: 'MPRCOIN SUPPORTER! Yüksek volatilite, yüksek heyecan. 800K havuzla sert hareketler geliyor, kemerleri bağlayın!',
  },
  {
    username: 'SVGC',
    email: 'svgc@test.com',
    text: 'SVGCOIN meme lordları burada mı?! En yüksek volatilite bizde, 0.005 USDT. Ya roket ya hiç! Not: yatırım tavsiyesi değildir :)',
  },
]

const results = []

async function registerOrLogin(page, p) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // Oturum açıksa çık (kalıcı profil önceki koşudan kalmış olabilir).
  const userMenu = page.locator('header button[aria-haspopup="menu"]')
  if (await userMenu.count()) {
    await userMenu.click()
    const logoutItem = page.getByRole('menuitem', { name: 'Çıkış Yap' })
    if (await logoutItem.count()) {
      await logoutItem.click()
      await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 8000 })
    }
  } else {
    await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).waitFor({ timeout: 15000 })
  }

  // Önce giriş dene (persona daha önce açılmış olabilir), olmazsa kayıt ol.
  await page.getByPlaceholder('kullanıcı adı veya e-posta').fill(p.email)
  await page.getByPlaceholder('••••••••').fill('test1234')
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).last().click()
  try {
    await page.locator('header').waitFor({ timeout: 6000 })
    console.log(`[INFO] ${p.username}: mevcut hesapla giriş yapıldı`)
    return
  } catch {
    // Giriş olmadı → kayıt ol.
  }
  await page.getByRole('button', { name: 'Kayıt Ol', exact: true }).click()
  await page.getByPlaceholder('örn. deniz_trader').fill(p.username)
  await page.getByPlaceholder('ornek@eposta.com').fill(p.email)
  const pw = page.getByPlaceholder('••••••••')
  await pw.first().fill('test1234')
  await pw.nth(1).fill('test1234')
  await page.getByRole('button', { name: 'Kayıt Ol ve Başla' }).click()
  await page.locator('header').waitFor({ timeout: 8000 })
  console.log(`[INFO] ${p.username}: yeni hesap açıldı`)
}

const browser = await chromium.launch({ headless: false, slowMo: 200 })

// Kalıcı profil: veriler diskte kalır, sıfırlamak için klasörü silmek yeterli.
console.log(`[INFO] profil klasörü: ${PROFILE_DIR}`)
const persistent = await chromium.launchPersistentContext(PROFILE_DIR, {
  viewport: { width: 1440, height: 900 },
  headless: false,
  slowMo: 400,
})
const page = persistent.pages()[0] ?? (await persistent.newPage())

try {
  for (const p of PERSONAS) {
    await registerOrLogin(page, p)
    await page.goto(`${BASE}#/forum`, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Yeni gönderi').waitFor({ timeout: 8000 })
    await page.getByLabel('Yeni gönderi').fill(p.text)
    await page.getByRole('button', { name: 'Paylaş' }).click()
    await page.getByText(p.text).waitFor({ timeout: 10000 })
    console.log(`[PASS] ${p.username} mesajı yayınlandı`)
    results.push(true)
    await page.screenshot({ path: `e2e/shots/seed-${p.username.toLowerCase()}.png` })
  }
  // Final: akışta 4 mesaj bir arada
  await page.goto(`${BASE}#/forum`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'e2e/shots/seed-forum-feed.png', fullPage: false })
  console.log('[PASS] akış görüntüsü alındı')
} catch (e) {
  console.log('[FAIL]', String(e).split('\n').slice(0, 3).join(' | '))
  await page.screenshot({ path: 'e2e/shots/seed-FAIL.png' })
  results.push(false)
} finally {
  await browser.close()
  await persistent.close()
}

if (results.some((r) => !r)) process.exit(1)
console.log('SONUÇ: 4/4 persona mesajı yayınlandı')
