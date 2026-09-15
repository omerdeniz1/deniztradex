import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEffectiveTheme } from '@/hooks/useEffectiveTheme'
import { useSettingsStore } from '@/store/settingsStore'

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useSettingsStore.setState({ theme: 'dark' })
})

describe('useEffectiveTheme', () => {
  it('forces light theme on mobile regardless of setting', () => {
    mockMatchMedia(true)
    useSettingsStore.setState({ theme: 'dark' })
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('light')
  })

  it('follows the user setting on desktop', () => {
    mockMatchMedia(false)
    useSettingsStore.setState({ theme: 'dark' })
    expect(renderHook(() => useEffectiveTheme()).result.current).toBe('dark')
    useSettingsStore.setState({ theme: 'light' })
    expect(renderHook(() => useEffectiveTheme()).result.current).toBe('light')
  })

  it('falls back to desktop behavior without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    useSettingsStore.setState({ theme: 'dark' })
    expect(renderHook(() => useEffectiveTheme()).result.current).toBe('dark')
  })
})
