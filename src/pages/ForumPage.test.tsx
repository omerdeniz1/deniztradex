import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ForumPage } from '@/pages/ForumPage'

const alice = { id: 'u_alice', username: 'alice', email: 'a@x.com', createdAt: 1 }

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('deniztradx_session', JSON.stringify(alice))
})

describe('ForumPage', () => {
  it('shows the composer and existing feed', async () => {
    render(<ForumPage />)
    expect(screen.getByLabelText('Yeni gönderi')).toBeInTheDocument()
    expect(await screen.findByText(/Topluluğa hoş geldin/)).toBeInTheDocument()
  })

  it('publishes a typed post to the top of the feed', async () => {
    const user = userEvent.setup()
    render(<ForumPage />)
    await screen.findByText(/Topluluğa hoş geldin/)

    await user.type(screen.getByLabelText('Yeni gönderi'), 'BTC bu hafta uçar mı?')
    await user.click(screen.getByRole('button', { name: 'Paylaş' }))

    expect(await screen.findByText('BTC bu hafta uçar mı?')).toBeInTheDocument()
  })

  it('toggles likes optimistically', async () => {
    const user = userEvent.setup()
    render(<ForumPage />)
    await screen.findByText(/Topluluğa hoş geldin/)

    await user.click(screen.getByRole('button', { name: 'Beğen' }))
    expect(await screen.findByRole('button', { name: 'Beğeniyi geri al' })).toBeInTheDocument()
  })

  it('rejects empty posts via disabled button', async () => {
    render(<ForumPage />)
    await screen.findByText(/Topluluğa hoş geldin/)
    expect(screen.getByRole('button', { name: 'Paylaş' })).toBeDisabled()
  })
})
