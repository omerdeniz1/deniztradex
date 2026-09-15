-- ============================================================
-- DenizTradeX — Alt yöneticiler için okuma yetkisi
--
-- Sorun: `profiles_admin_select` (ve işlem okuma politikası) yalnız
-- `is_admin()` kontrolü yapıyordu. İzinli alt yönetici kullanıcı
-- listesini çektiğinde RLS ona SADECE kendi satırını gösteriyordu;
-- göremediği kimseye işlem yapamıyor, tabloda tek başına kalıyordu.
--
-- Çözüm: `is_staff()` (süper admin VEYA en az bir izni olan alt
-- yönetici) tanımlanır; tüm admin OKUMA politikaları buna geçirilir.
-- YAZMA tarafı bilerek değişmez: doğrudan tablo güncellemesi süper
-- admin'e özeldir, alt yönetici yazımları `admin_update_profile`
-- RPC'sinden geçer (alan bazında izin denetimli) + ayrıcalık koruma
-- tetikleyicisi backstop'tur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles as p
    where p.id = auth.uid()
      and (
        p.is_admin = true
        or coalesce(array_length(p.admin_permissions, 1), 0) > 0
      )
  );
$$;

revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to anon, authenticated;

drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select
  on public.profiles for select
  using (public.is_staff());

drop policy if exists transactions_admin_select on public.transactions;
create policy transactions_admin_select
  on public.transactions for select
  using (public.is_staff());
