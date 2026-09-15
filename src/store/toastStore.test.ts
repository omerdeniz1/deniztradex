import { beforeEach, describe, expect, it } from 'vitest'
import { useToastStore } from '@/store/toastStore'

beforeEach(() => {
  useToastStore.getState().clearNotifications()
  useToastStore.setState({ toasts: [] })
})

describe('toastStore notifications', () => {
  it('records pushed toasts into history with an unread count', () => {
    useToastStore.getState().push({ message: 'Emir gönderildi', tone: 'success' })
    const s = useToastStore.getState()
    expect(s.notifications).toHaveLength(1)
    expect(s.notifications[0]).toMatchObject({ message: 'Emir gönderildi', tone: 'success' })
    expect(s.unread).toBe(1)
  })

  it('markAllRead clears the badge but keeps history', () => {
    useToastStore.getState().push({ message: 'a' })
    useToastStore.getState().markAllRead()
    expect(useToastStore.getState().unread).toBe(0)
    expect(useToastStore.getState().notifications).toHaveLength(1)
  })

  it('clearNotifications empties history and badge', () => {
    useToastStore.getState().push({ message: 'a' })
    useToastStore.getState().push({ message: 'b' })
    useToastStore.getState().clearNotifications()
    expect(useToastStore.getState().notifications).toHaveLength(0)
    expect(useToastStore.getState().unread).toBe(0)
  })
})
