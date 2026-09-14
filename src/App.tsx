import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useTradeStore } from '@/store/tradeStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useUiStore } from '@/store/uiStore'
import { AuthScreen } from '@/components/auth/AuthScreen'
import { Navbar } from '@/components/Navbar'
import { BottomNav } from '@/components/BottomNav'
import { Toasts } from '@/components/ui/Toasts'
import { DepositModal } from '@/components/wallet/DepositModal'
import { WithdrawModal } from '@/components/wallet/WithdrawModal'
import { TradeScreen } from '@/components/trading/TradeScreen'
import { HomePage } from '@/pages/HomePage'
import { MarketsPage } from '@/pages/MarketsPage'
import { WalletPage } from '@/pages/WalletPage'
import { SettingsPage } from '@/pages/SettingsPage'

export default function App() {
  const user = useAuthStore((s) => s.user)

  return (
    <HashRouter>
      {user ? <Shell /> : <AuthScreen />}
      <Toasts />
    </HashRouter>
  )
}

function ThemeManager() {
  const theme = useSettingsStore((s) => s.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return null
}

function Shell() {
  const user = useAuthStore((s) => s.user)
  const balance = useTradeStore((s) => s.balance)
  const depositOpen = useUiStore((s) => s.depositOpen)
  const closeDeposit = useUiStore((s) => s.closeDeposit)
  const withdrawOpen = useUiStore((s) => s.withdrawOpen)
  const closeWithdraw = useUiStore((s) => s.closeWithdraw)

  return (
    <div className="flex h-dvh min-h-0 w-full max-w-full flex-col overflow-x-hidden bg-exchange-bg text-exchange-text">
      <ThemeManager />
      <Navbar balance={balance} username={user?.username ?? ''} />
      <div className="flex min-h-0 flex-1 flex-col pb-20 sm:pb-0">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/markets" element={<MarketsPage />} />
          <Route path="/spot" element={<TradeScreen mode="spot" />} />
          <Route path="/futures" element={<TradeScreen mode="futures" />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <BottomNav />
      <DepositModal open={depositOpen} onClose={closeDeposit} />
      <WithdrawModal open={withdrawOpen} onClose={closeWithdraw} />
    </div>
  )
}