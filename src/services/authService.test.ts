import { beforeEach, describe, expect, it } from 'vitest'
import { changePassword, changeUsername, login, register } from '@/services/authService'

beforeEach(() => {
  localStorage.clear()
})

describe('changePassword (yerel backend)', () => {
  it('mevcut şifre doğruysa değiştirir ve yeni şifreyle giriş açılır', async () => {
    await register({ username: 'sifreuser', email: 'sifre@x.com', password: 'eski123' })

    await changePassword('eski123', 'yeni456')

    await expect(login('sifreuser', 'yeni456')).resolves.toMatchObject({
      username: 'sifreuser',
    })
    await expect(login('sifreuser', 'eski123')).rejects.toThrow('Hatalı şifre.')
  })

  it('mevcut şifre yanlışsa reddeder', async () => {
    await register({ username: 'sifreuser2', email: 'sifre2@x.com', password: 'eski123' })

    await expect(changePassword('yanlis', 'yeni456')).rejects.toThrow('Mevcut şifren hatalı.')
  })

  it('6 karakterden kısa yeni şifreyi reddeder', async () => {
    await register({ username: 'sifreuser3', email: 'sifre3@x.com', password: 'eski123' })

    await expect(changePassword('eski123', 'kisa')).rejects.toThrow('en az 6 karakter')
  })

  it('mevcut şifreyle aynı yeni şifreyi reddeder', async () => {
    await register({ username: 'sifreuser4', email: 'sifre4@x.com', password: 'eski123' })

    await expect(changePassword('eski123', 'eski123')).rejects.toThrow('farklı olmalı')
  })

  it('oturum yoksa reddeder', async () => {
    await expect(changePassword('mevcut1', 'yeni1234')).rejects.toThrow('Oturum bulunamadı')
  })
})

describe('changeUsername (yerel backend)', () => {
  it('kullanıcı adını + etiketi günceller, eski isim serbest kalır', async () => {
    await register({ username: 'eskiad', email: 'ad@x.com', password: 'sifre123' })
    const updated = await changeUsername('yeniad', 'Balina')
    expect(updated).toMatchObject({ username: 'yeniad', userTag: 'Balina' })
    // Eski isimle sıfırdan kayıt açılabilir.
    await expect(
      register({ username: 'eskiad', email: 'baska@x.com', password: 'sifre123' }),
    ).resolves.toMatchObject({ username: 'eskiad' })
  })

  it('alınmış ismi ve rezerve adları reddeder', async () => {
    await register({ username: 'birinci', email: 'bir@x.com', password: 'sifre123' })
    await register({ username: 'ikinci', email: 'iki@x.com', password: 'sifre123' })
    await expect(changeUsername('birinci')).rejects.toThrow('zaten kullanılıyor')
    await expect(changeUsername('admin')).rejects.toThrow('kullanılamaz')
    await expect(changeUsername('ab')).rejects.toThrow('en az 3 karakter')
  })

  it('boş etiket null sayılır', async () => {
    await register({ username: 'etiketsiz', email: 'et@x.com', password: 'sifre123' })
    const updated = await changeUsername('etiketsiz2', '   ')
    expect(updated.userTag).toBeNull()
  })
})
