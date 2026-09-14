import { create } from 'zustand'

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  readonly id: string
  readonly message: string
  readonly tone: ToastTone
}

interface ToastState {
  toasts: Toast[]
  push: (toast: { message: string; tone?: ToastTone }) => string
  dismiss: (id: string) => void
}

let counter = 0

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: ({ message, tone = 'info' }) => {
    const id = `toast_${Date.now().toString(36)}_${++counter}`
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }))
    setTimeout(() => get().dismiss(id), 5000)
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))