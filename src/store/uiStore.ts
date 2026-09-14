import { create } from 'zustand'

interface UiState {
  depositOpen: boolean
  openDeposit: () => void
  closeDeposit: () => void
  withdrawOpen: boolean
  openWithdraw: () => void
  closeWithdraw: () => void
}

export const useUiStore = create<UiState>()((set) => ({
  depositOpen: false,
  openDeposit: () => set({ depositOpen: true }),
  closeDeposit: () => set({ depositOpen: false }),
  withdrawOpen: false,
  openWithdraw: () => set({ withdrawOpen: true }),
  closeWithdraw: () => set({ withdrawOpen: false }),
}))