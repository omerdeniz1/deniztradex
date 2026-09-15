-- ============================================================
-- DenizTradeX — Para yatırma / çekme kısıtlaması (kullanıcı bazında)
--
-- `profiles.deposit_blocked` / `profiles.withdraw_blocked`: true ise
-- kullanıcı o yönde işlem yapamaz (giriş + al-sat serbest kalır;
-- dondurma/yasaktan farkı budur).
--
-- Yeni izin: 'restrict_money' → "Para İşlemlerini Kısıtlayabilir".
-- `is_admin = true` süper admin demektir (tüm yetkiler).
--
-- Zorlama iki katmanlıdır:
--  1) Uygulama, işleme başlamadan bayrağı okuyup kullanıcıyı anında
--     durdurur (hata mesajıyla).
--  2) Sunucu backstop'u: kısıtlı hesabın defter satırı
--     (`deposit_history` / `withdraw` tipi `transactions`) tetikleyiciyle
--     reddedilir — sunucu defteri kirlenmez.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.profiles
  add column if not exists deposit_blocked boolean not null default false;

alter table public.profiles
  add column if not exists withdraw_blocked boolean not null default false;

-- Eski 6 parametreli RPC sürümünü kaldır (bu dosyayla birlikte
-- çalıştırılan güncel bölüm 8 parametreli sürümü kurar; aksi halde
-- iki sürüm yan yana kalır).
drop function if exists public.admin_update_profile(uuid, numeric, boolean, boolean, boolean, text[]);

-- ------------------------------------------------------------
-- Ayrıcalık koruması: para kısıt alanlarına yalnızca süper admin
-- veya `restrict_money` izinli alt yönetici dokunabilir.
-- (Fonksiyon baştan kurulur; önceki kurallar aynen korunur.)
-- ------------------------------------------------------------
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
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

-- ------------------------------------------------------------
-- Defter backstop'ları: kısıtlı hesabın sunucu kaydı reddedilir.
-- ------------------------------------------------------------
create or replace function public.guard_deposit_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.profiles as p
    where p.id = NEW.user_id and p.deposit_blocked = true
  ) then
    raise exception 'para yatırma kısıtlı';
  end if;
  return NEW;
end;
$$;

drop trigger if exists deposit_ledger_guard on public.deposit_history;
create trigger deposit_ledger_guard
  before insert on public.deposit_history
  for each row execute function public.guard_deposit_ledger();

create or replace function public.guard_withdraw_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.type = 'withdraw' and exists (
    select 1 from public.profiles as p
    where p.id = NEW.user_id and p.withdraw_blocked = true
  ) then
    raise exception 'para çekme kısıtlı';
  end if;
  return NEW;
end;
$$;

drop trigger if exists withdraw_ledger_guard on public.transactions;
create trigger withdraw_ledger_guard
  before insert on public.transactions
  for each row execute function public.guard_withdraw_ledger();
