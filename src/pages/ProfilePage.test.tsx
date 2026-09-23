import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProfilePage } from '@/pages/ProfilePage'

function renderProfile(username: string) {
  return render(
    <MemoryRouter initialEntries={[`/profile/${username}`]}>
      <Routes>
        <Route path="/profile/:username" element={<ProfilePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('ProfilePage (çevrimdışı persona)', () => {
  it('persona profilini taban sayılarla gösterir', async () => {
    renderProfile('blackrock')
    expect(await screen.findByText('BlackRock')).toBeInTheDocument()
    // 780.000 → "780 B" kısaltması
    expect(await screen.findByText('780 B')).toBeInTheDocument()
    expect(screen.getByText('Kurumsal kripto masası parodisi — ETF akımları, makro ve risk iştahı notları. Yatırım tavsiyesi değildir.')).toBeInTheDocument()
  })

  it('bilinmeyen hesapta bulunamadı ekranı verir', async () => {
    renderProfile('kimseboylebiri')
    expect(await screen.findByText('@kimseboylebiri bulunamadı.')).toBeInTheDocument()
  })
})
