import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // Binance SPOT REST (api.binance.com)
      '/binance-spot': {
        target: 'https://api.binance.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/binance-spot/, ''),
      },
      // Binance SPOT REST mirror (geo-blocked regions fallback)
      '/binance-spot-mirror': {
        target: 'https://data-api.binance.vision',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/binance-spot-mirror/, ''),
      },
      // Binance USDT-M Futures REST
      '/binance-futures': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/binance-futures/, ''),
      },
      // Binance WebSocket (primary)
      '/binance-ws': {
        target: 'wss://stream.binance.com:9443',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/binance-ws/, ''),
      },
      // Binance WebSocket mirror (geo-blocked regions fallback)
      '/binance-ws-mirror': {
        target: 'wss://data-stream.binance.vision',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/binance-ws-mirror/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: true,
    restoreMocks: true,
  },
})