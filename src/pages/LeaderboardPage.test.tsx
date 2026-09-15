import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeaderboardPage } from '@/pages/LeaderboardPage'

describe('LeaderboardPage', () => {
  it('shows the header, formula and an error state when offline', async () => {
    render(<LeaderboardPage />)
    expect(screen.getByText('Sıralama')).toBeInTheDocument()
    expect(screen.getByText(/Portföy %40/)).toBeInTheDocument()
    // Test modunda Supabase kapalı → hata bandı + tekrar dene.
    expect(await screen.findByText('Tekrar dene')).toBeInTheDocument()
  })
})
