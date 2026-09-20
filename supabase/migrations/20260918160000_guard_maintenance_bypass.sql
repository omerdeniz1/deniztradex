-- ============================================================
-- DenizTradeX — bakım (maintenance) baypası: tablo sahibi engellenmez
--
-- Hata: `APPLY_ALL_PENDING.sql` SQL Editor'de çalıştırılırken
-- wallet_transfer backfill'i şu hatayla duruyordu:
--   ERROR P0001: süper admin hesabına müdahale edemezsin
--   CONTEXT: PL/pgSQL function protect_profile_privileges() ... RAISE
--   STATEMENT: update public.profiles set wallet_no = ...
-- Neden: SQL Editor doğrudan `postgres` rolüyle, JWT'siz bağlanır;
--   `auth.uid()` NULL → `public.is_admin()` false → SÜPER ADMİN
--   satırına değen HER update (backfill dahil) reddedilir.
--
-- Çözüm: koruyucu tetikleyici, doğrudan tablo-sahibi bakım
-- oturumlarında (`session_user = 'postgres'`: SQL Editor, psql,
-- `supabase db push`) satırı aynen geçirir; diğer tüm roller
-- (anon/authenticated/service_role — hepsi PostgREST üzerinden
-- `authenticator` oturumuyla gelir) için TÜM kontroller aynen çalışır.
--
-- Güvenlik notu: KRİTİK — kontrol `session_user` ile yapılır,
-- `current_user` ile DEĞİL. Bu fonksiyon SECURITY DEFINER'dır;
-- içinde `current_user` her zaman fonksiyon sahibidir (bypass herkese
-- açılırdı — YANLIŞ). `session_user` bağlantı sahibidir ve SET ROLE
-- ile değişmez. Ayrıca kayıp YOK: owner zaten trigger'ları
-- devre dışı bırakabilir (`ALTER TABLE ... DISABLE TRIGGER`);
-- bu koruma baştan beri yalnızca API rollerine karşıydı.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Bakım baypası: doğrudan tablo-sahibi oturumu (SQL Editor/psql/db
  -- push). API rolleri `authenticator` oturumuyla gelir, etkilenmez.
  if session_user = 'postgres' then
    return NEW;
  end if;

  -- Süper admin hedef dokunulmazlığı (tüm alanlar, tüm arayanlar).
  if OLD.is_admin = true and not public.is_admin() then
    raise exception 'süper admin hesabına müdahale edemezsin';
  end if;

  if (NEW.is_admin is distinct from OLD.is_admin
      or NEW.admin_permissions is distinct from OLD.admin_permissions) then
    if not public.is_admin()
       and not public.has_admin_permission(v_uid, 'manage_admins') then
       raise exception 'yetkisiz işlem: admin yönetimi yetkisi gerekli';
    end if;
  end if;

  if (NEW.is_frozen is distinct from OLD.is_frozen
      or NEW.is_banned is distinct from OLD.is_banned) then
    if not public.is_admin()
       and not public.has_admin_permission(v_uid, 'ban_users') then
       raise exception 'yetkisiz işlem: ban yetkisi gerekli';
    end if;
  end if;

  if (NEW.deposit_blocked is distinct from OLD.deposit_blocked
      or NEW.withdraw_blocked is distinct from OLD.withdraw_blocked) then
    if not public.is_admin()
       and not public.has_admin_permission(v_uid, 'restrict_money') then
       raise exception 'yetkisiz işlem: para işlemleri kısıtlama yetkisi gerekli';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists profiles_privilege_guard on public.profiles;
create trigger profiles_privilege_guard
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();
