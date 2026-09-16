-- ============================================================
-- DenizTradeX — Sistem duyuruları (süper admin yayınları)
--
-- `announcements`: süper adminin tüm kullanıcılara yayınladığı
-- duyurular. Okuma her giriş yapmış kullanıcıya açık; yazma
-- (ekle/sil) YALNIZCA `is_admin = true` süper adminlere aittir
-- (`public.is_admin()` RLS politikasıyla zorlanır).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 120),
  body       text not null check (char_length(body) between 1 and 1000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists announcements_created_at_idx
  on public.announcements (created_at desc);

alter table public.announcements enable row level security;

-- Tüm giriş yapmış kullanıcılar duyuruları okur.
drop policy if exists announcements_select_all on public.announcements;
create policy announcements_select_all
  on public.announcements for select
  to authenticated
  using (true);

-- Yalnızca süper admin yayınlar.
drop policy if exists announcements_admin_insert on public.announcements;
create policy announcements_admin_insert
  on public.announcements for insert
  to authenticated
  with check (public.is_admin());

-- Yalnızca süper admin siler.
drop policy if exists announcements_admin_delete on public.announcements;
create policy announcements_admin_delete
  on public.announcements for delete
  to authenticated
  using (public.is_admin());
