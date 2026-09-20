import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { maybeAutoStartRetailBot } from '@/services/retailBotService'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Perakende botu (halk simülasyonu): localStorage `deniztradx_retail_bot`
// === "1" veya VITE_RETAIL_BOT=1 ise sanal havuzlarda 2–7 sn'de bir
// 10–150$'lık al/sat baskısı üretir. Varsayılan KAPALI — tek admin
// sekmesinde açın (her ziyaretçide çalışmamalı). Konsol: __retailBot.
maybeAutoStartRetailBot()