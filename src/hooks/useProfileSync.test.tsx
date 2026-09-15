import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { useProfileSync } from '@/hooks/useProfileSync'

function Harness() {
  useProfileSync()
  return null
}

describe('useProfileSync', () => {
  it('renders nothing and stays quiet without session or backend', () => {
    localStorage.clear()
    const { container, unmount } = render(<Harness />)
    expect(container).toBeEmptyDOMElement()
    unmount()
  })
})
