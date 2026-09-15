import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AdminPage } from '@/pages/AdminPage'

const alice = { id: 'u_alice', username: 'alice', email: 'a@x.com', createdAt: 1 }

function renderAtAdmin() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/" element={<div>Ana sayfa içeriği</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('AdminPage guard', () => {
  it('redirects to home when not logged in', async () => {
    renderAtAdmin()
    expect(await screen.findByText('Ana sayfa içeriği')).toBeInTheDocument()
  })

  it('redirects to home for non-admin users (offline backend)', async () => {
    // Test modunda Supabase kapalı → checkIsAdmin her zaman false.
    localStorage.setItem('deniztradx_session', JSON.stringify(alice))
    renderAtAdmin()
    expect(await screen.findByText('Ana sayfa içeriği')).toBeInTheDocument()
  })
})
