import { defineConfig, devices } from '@playwright/test'

/**
 * DenizTradeX E2E altyapısı.
 *
 * - 4 profil eşzamanlı koşar (workers otomatik): Desktop Chrome,
 *   Desktop Safari (WebKit), iPhone 14 Pro, Pixel 7.
 * - Uygulama `npm run dev` ile ayağa kaldırılır; Supabase ENV'leri
 *   bilerek BOŞALTILIR → testler deterministik localStorage backend
 *   ile çalışır (gerçek DB'ye dokunulmaz, ağ gerekmez).
 * - Tek tık: `npm run test:e2e`
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
  },
  webServer: {
    // Windows uyumluluğu: `npm run dev` shell'siz asılı kalır, doğrudan vite çalıştırılır.
    // `--host 127.0.0.1`: vite varsayılan `localhost`'u IPv6'ya bağlayabilir,
    // Playwright ise 127.0.0.1'i yoklar (ECONNREFUSED döngüsünü önler).
    command: 'npx vite --port 5173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Deterministik E2E: gerçek Supabase'e çıkılmasın.
    env: {
      ...process.env,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    } as Record<string, string>,
  },
  projects: [
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'Desktop Safari',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'iPhone 14 Pro',
      use: { ...devices['iPhone 14 Pro'] },
    },
    {
      name: 'Pixel 7',
      use: { ...devices['Pixel 7'] },
    },
  ],
})
