-- ============================================================
-- DenizTradeX — RLS sıkılaştırma (profil sızıntısı kapatma)
--
-- Durum: `profiles` tablosu anonim anahtarla herkese açık okunuyordu
-- (tüm kullanıcıların e-posta + bakiyeleri sızıyordu). Bu dosya tabloyu
-- tasarım durumuna döndürür:
--   - SELECT/UPDATE: yalnızca kendi satırı + yöneticiler,
--   - INSERT: yalnızca kendi satırı (upsert dayanıklılığı için),
--   - DELETE: kimse (varsayılan ret),
--   - Ayrıcalık kolonları INSERT'te de korunur (kendini admin yapma
--     koruması INSERT yolunu da kapatır).
--
-- Bilinmeyen adlı, herkese açık politikalar pg_policies üzerinden
-- temizlenir; iyi bilinen politikalar korunur. RLS tüm tablolarda
-- zorunlu kılınır. Uygulama akışları (anon giriş-öncesi RPC, kendi
-- satırı okuma/yazma, admin paneli) bu kuralla birebir uyumludur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) profiles: izin listesindeki politikalar dışındaki tüm
--    SELECT/UPDATE/INSERT/DELETE politikalarını kaldır.
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select policyname, cmd from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
  loop
    if r.cmd = 'SELECT' and r.policyname not in ('profiles_select_own', 'profiles_admin_select') then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    elsif r.cmd = 'UPDATE' and r.policyname not in ('profiles_update_own', 'profiles_admin_update') then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    elsif r.cmd = 'INSERT' and r.policyname not in ('profiles_insert_own') then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    elsif r.cmd = 'DELETE' then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 2) Kendi-satırı politikaları (init ile birebir) + upsert için
--    INSERT politikası.
-- ------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles for insert
  with check (auth.uid() = id);

-- Admin politikaları (yoksa kur, varsa tazele).
drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select
  on public.profiles for select
  using (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- 3) INSERT ayrıcalık koruması: yönetici olmayan hiç kimse satır
--    oluştururken is_admin / is_frozen / is_banned /
--    admin_permissions değerlerini yükseltemez (varsayılanlara çekilir).
-- ------------------------------------------------------------
create or replace function public.protect_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    NEW.is_admin := false;
    NEW.is_frozen := false;
    NEW.is_banned := false;
    NEW.admin_permissions := '{}';
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_insert_guard on public.profiles;
create trigger profiles_insert_guard
  before insert on public.profiles
  for each row execute function public.protect_profile_insert();

-- ------------------------------------------------------------
-- 4) Defter tabloları: kendi-satırı + admin okuma (init ile birebir).
-- ------------------------------------------------------------
drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own
  on public.transactions for select
  using (auth.uid() = user_id);

drop policy if exists transactions_insert_own on public.transactions;
create policy transactions_insert_own
  on public.transactions for insert
  with check (auth.uid() = user_id);

drop policy if exists transactions_admin_select on public.transactions;
create policy transactions_admin_select
  on public.transactions for select
  using (public.is_admin());

drop policy if exists deposit_history_select_own on public.deposit_history;
create policy deposit_history_select_own
  on public.deposit_history for select
  using (auth.uid() = user_id);

drop policy if exists deposit_history_insert_own on public.deposit_history;
create policy deposit_history_insert_own
  on public.deposit_history for insert
  with check (auth.uid() = user_id);

drop policy if exists deposit_history_admin_select on public.deposit_history;
create policy deposit_history_admin_select
  on public.deposit_history for select
  using (public.is_admin());

-- ------------------------------------------------------------
-- 5) RLS'yi tüm uygulama tablolarında zorunlu kıl.
-- ------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.transactions    enable row level security;
alter table public.deposit_history enable row level security;
alter table public.forum_posts     enable row level security;
alter table public.forum_likes     enable row level security;
alter table public.forum_replies   enable row level security;

-- ------------------------------------------------------------
-- 6) Grant sıkılaştırma: anon artık profiles/defter okuyamaz.
--    Forum herkese-açık okuma korunur (tasarım gereği).
-- ------------------------------------------------------------
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

revoke all on public.transactions from anon;
grant select, insert on public.transactions to authenticated;

revoke all on public.deposit_history from anon;
grant select, insert on public.deposit_history to authenticated;

grant select on public.forum_posts to anon, authenticated;
grant insert, delete on public.forum_posts to authenticated;
grant select, insert, delete on public.forum_likes to authenticated;
grant select on public.forum_replies to anon, authenticated;
grant insert, delete on public.forum_replies to authenticated;
