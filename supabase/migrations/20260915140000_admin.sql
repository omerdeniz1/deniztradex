-- ============================================================
-- DenizTradeX — Admin Panel yetkilendirme + hesap dondurma
--
-- `profiles.is_admin`:  /admin paneline girebilen yöneticiler.
-- `profiles.is_frozen`: dondurulan hesaplar giriş yapamaz.
--
-- Güvenlik notları:
--  - `is_admin()` SECURITY DEFINER'dır (RLS'yi baypas eder), böylece
--    politika içinde kendini okuma özyinelemesi olmaz.
--  - `protect_profile_privileges` tetikleyicisi, normal kullanıcıların
--    kendi satırlarını güncellerken `is_admin`/`is_frozen` alanlarını
--    değiştirmesini engeller (ayrıcalık yükseltme koruması). Yönetici
--    olmayan biri bu alanlara dokunursa işlem hata ile reddedilir.
--  - Mevcut `profiles_select_own` / `profiles_update_own` politikaları
--    korunur; admin politikaları ek olarak tanımlanır.
--
-- İlk yönetici atama (SQL Editor'de, kendi e-postanla):
--   update public.profiles set is_admin = true
--   where lower(email) = lower('ornek@eposta.com');
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

alter table public.profiles
  add column if not exists is_frozen boolean not null default false;

create index if not exists profiles_is_admin_idx
  on public.profiles (is_admin) where is_admin;

-- ------------------------------------------------------------
-- is_admin(): giriş yapan kullanıcı yönetici mi?
-- SECURITY DEFINER olduğu için RLS'ye takılmadan kendi satırını
-- okur; politika içinden güvenle çağrılır.
-- ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles as p
    where p.id = auth.uid() and p.is_admin = true
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ------------------------------------------------------------
-- Ayrıcalık yükseltme koruması: yönetici olmayan hiç kimse
-- (kendi satırı dahil) is_admin / is_frozen alanlarını
-- değiştiremez.
-- ------------------------------------------------------------
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (NEW.is_admin is distinct from OLD.is_admin
      or NEW.is_frozen is distinct from OLD.is_frozen)
     and not public.is_admin() then
    raise exception 'yetkisiz işlem: yönetici yetkisi gerekli';
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_privilege_guard on public.profiles;
create trigger profiles_privilege_guard
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ------------------------------------------------------------
-- Admin RLS politikaları (mevcut kullanıcı politikaları korunur).
-- ------------------------------------------------------------
drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select
  on public.profiles for select
  using (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- Yöneticiler tüm işlem kayıtlarını denetim için okuyabilir.
drop policy if exists transactions_admin_select on public.transactions;
create policy transactions_admin_select
  on public.transactions for select
  using (public.is_admin());

drop policy if exists deposit_history_admin_select on public.deposit_history;
create policy deposit_history_admin_select
  on public.deposit_history for select
  using (public.is_admin());
