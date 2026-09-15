import { create } from 'zustand'

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  readonly id: string
  readonly message: string
  readonly tone: ToastTone
}

export interface NotificationItem {
  readonly id: string
  readonly message: string
  readonly tone: ToastTone
  readonly at: number
}

/** Bildirim merkezinde tutulacak en fazla kayıt. */
const HISTORY_LIMIT = 30

interface ToastState {
  toasts: Toast[]
  push: (toast: { message: string; tone?: ToastTone }) => string
  dismiss: (id: string) => void
  /** Kalıcı bildirim geçmişi (en yeni en üstte) — navbar'daki zil ikonunda listelenir. */
  notifications: NotificationItem[]
  /** Okunmamış bildirim sayısı (zil rozeti). */
  unread: number
  markAllRead: () => void
  clearNotifications: () => void
}

let counter = 0

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  notifications: [],
  unread: 0,
  push: ({ message, tone = 'info' }) => {
    const id = `toast_${Date.now().toString(36)}_${++counter}`
    const item = { id, message, tone }
    set((s) => ({ toasts: [...s.toasts, item] }))
    // Geçici toast kaybolsa da bildirim merkezinde durur.
    set((s) => ({
      notifications: [{ ...item, at: Date.now() }, ...s.notifications].slice(0, HISTORY_LIMIT),
      unread: s.unread + 1,
    }))
    setTimeout(() => get().dismiss(id), 5000)
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markAllRead: () => set({ unread: 0 }),
  clearNotifications: () => set({ notifications: [], unread: 0 }),
}))