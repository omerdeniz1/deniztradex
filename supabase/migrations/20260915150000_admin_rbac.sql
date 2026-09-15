-- ============================================================
-- DenizTradeX — Gelişmiş admin yetkilendirme (RBAC) + kalıcı ban
--              + forum onay rozeti (verified)
--
-- 1) RBAC: `profiles.admin_permissions` (text[]) ile alt yönetici
--    yetkileri. Geçerli izinler:
--      'edit_balance'    → Bakiye Düzenleyebilir
--      'ban_users'       → Kullanıcı Banlayabilir (dondur + yasakla)
--      'change_password' → Şifre Değiştirebilir (sıfırlama e-postası)
--      'manage_admins'   → Admin Ekleyebilir (yetki atama/kaldırma)
--    `is_admin = true` süper admin demektir (tüm yetkiler).
--    `is_admin = false` + dolu `admin_permissions` = alt yönetici.
--
-- 2) Kalıcı ban: `profiles.is_banned`. Yasaklı hesap giriş yapamaz
--    (uygulama login akışı bu bayrağı denetler).
--
-- 3) `admin_update_profile` RPC'si: tüm admin yazımları tek kapıdan
--    geçer ve sunucu tarafında yetki denetimi yapar (RLS'yi baypas
--    eden SECURITY DEFINER; alan bazında izin kontrolü).
--
-- 4) Forum rozeti: `forum_posts.is_verified` / `forum_replies.is_verified`.
--    Yazı eklenirken tetikleyici, yazar süper adminse (veya sistem
--    hesabı `deniztradex` ise) rozeti otomatik işaretler. İstemcinin
--    gönderdiği değer ezilir — kullanıcı kendine rozet veremez.
--
-- Idempotent: tekrar çalıştırılabilir, mevcut veriyi bozmaz.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Yeni kolonlar
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists admin_permissions text[] not null default '{}';

alter table public.profiles
  add column if not exists is_banned boolean not null default false;

-- ------------------------------------------------------------
-- 2) Yetki yardımcısı: süper admin her izne sahiptir.
-- ------------------------------------------------------------
create or replace function public.has_admin_permission(p_uid uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles as p
    where p.id = p_uid
      and (
        p.is_admin = true
        or p_perm = any (coalesce(p.admin_permissions, '{}'))
      )
  );
$$;

revoke all on function public.has_admin_permission(uuid, text) from public;
grant execute on function public.has_admin_permission(uuid, text) to anon, authenticated;

-- ------------------------------------------------------------
-- Rozet yardımcısı (forum tier dosyasıyla birebir aynı; hangi
-- migration önce çalışırsa çalışsın RPC bağımsız olsun diye
-- burada da tanımlı — create or replace ile idempotent).
-- ------------------------------------------------------------
create or replace function public.forum_verified_tier(p_user_id uuid, p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when lower(coalesce(p_username, '')) = 'deniztradex' then 'super'
    when exists (select 1 from public.profiles where id = p_user_id and is_admin = true) then 'super'
    when exists (
      select 1 from public.profiles
      where id = p_user_id
        and coalesce(array_length(admin_permissions, 1), 0) > 0
    ) then 'admin'
    else 'none'
  end;
$$;

revoke all on function public.forum_verified_tier(uuid, text) from public;
grant execute on function public.forum_verified_tier(uuid, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3) Ayrıcalık korumasını yeni alanlarla güncelle: yönetici
--    olmayan hiç kimse is_admin / admin_permissions / is_frozen /
--    is_banned alanlarına dokunamaz. Alt yöneticiler yalnızca
--    sahip oldukları iznin kapsadığı alanı değiştirebilir
--    (yetki atama → manage_admins, dondur/yasakla → ban_users).
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

  return NEW;
end;
$$;

drop trigger if exists profiles_privilege_guard on public.profiles;
create trigger profiles_privilege_guard
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ------------------------------------------------------------
-- 4) Admin yazım RPC'si: bakiye / dondur / yasakla / yetki atama
--    tek fonksiyonda, alan bazında sunucu taraflı izin denetimli.
--    NULL geçen alanlara dokunulmaz.
-- ------------------------------------------------------------
create or replace function public.admin_update_profile(
  p_user_id    uuid,
  p_balance    numeric default null,
  p_is_frozen  boolean default null,
  p_is_banned  boolean default null,
  p_is_admin   boolean default null,
  p_permissions text[] default null,
  p_deposit_blocked boolean default null,
  p_withdraw_blocked boolean default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_super  boolean := false;
  v_bad    text;
begin
  if v_caller is null then
    raise exception 'giriş gerekli';
  end if;

  select (p.is_admin = true) into v_super
  from public.profiles as p
  where p.id = v_caller;

  if not v_super then
    if not exists (
      select 1 from public.profiles as p
      where p.id = v_caller
        and coalesce(array_length(p.admin_permissions, 1), 0) > 0
    ) then
      raise exception 'yetkisiz işlem: yönetici yetkisi gerekli';
    end if;
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'kullanıcı bulunamadı';
  end if;

  -- Bakiye
  if p_balance is not null then
    if p_balance < 0 then
      raise exception 'geçersiz bakiye';
    end if;
    if not v_super and not public.has_admin_permission(v_caller, 'edit_balance') then
      raise exception 'yetkisiz işlem: bakiye yetkisi gerekli';
    end if;
    update public.profiles set balance = p_balance where id = p_user_id;
  end if;

  -- Dondur / yasakla (kendine yasak)
  if p_is_frozen is not null or p_is_banned is not null then
    if p_user_id = v_caller then
      raise exception 'kendi hesabında bu işlemi yapamazsın';
    end if;
    if not v_super and not public.has_admin_permission(v_caller, 'ban_users') then
      raise exception 'yetkisiz işlem: ban yetkisi gerekli';
    end if;
    update public.profiles
    set is_frozen = coalesce(p_is_frozen, is_frozen),
        is_banned = coalesce(p_is_banned, is_banned)
    where id = p_user_id;
  end if;

  -- Yetki atama (kendine yasak)
  if p_is_admin is not null or p_permissions is not null then
    if p_user_id = v_caller then
      raise exception 'kendi yetkilerini değiştiremezsin';
    end if;
    if not v_super and not public.has_admin_permission(v_caller, 'manage_admins') then
      raise exception 'yetkisiz işlem: admin yönetimi yetkisi gerekli';
    end if;
    -- Süper admin hedeflere ve süperlik bayrağına yalnız süper admin dokunur.
    if not v_super then
      if exists (select 1 from public.profiles where id = p_user_id and is_admin = true) then
        raise exception 'süper admin yetkilerini yalnızca süper admin değiştirebilir';
      end if;
      if p_is_admin is not null and p_is_admin = true then
        raise exception 'süper admin yetkisini yalnızca süper admin verebilir';
      end if;
    end if;
    if p_permissions is not null then
      select x into v_bad
      from unnest(p_permissions) as x
      where x not in ('edit_balance', 'ban_users', 'change_password', 'manage_admins', 'restrict_money')
      limit 1;
      if v_bad is not null then
        raise exception 'geçersiz yetki: %', v_bad;
      end if;
    end if;
    update public.profiles
    set is_admin = coalesce(p_is_admin, is_admin),
        admin_permissions = coalesce(p_permissions, admin_permissions)
    where id = p_user_id;

    -- Yazarın eski forum yazılarının rozetlerini yeni yetkiye göre tazele.
    update public.forum_posts
    set verified_tier = public.forum_verified_tier(user_id, username),
        is_verified = (public.forum_verified_tier(user_id, username) <> 'none')
    where user_id = p_user_id;

    update public.forum_replies
    set verified_tier = public.forum_verified_tier(user_id, username),
        is_verified = (public.forum_verified_tier(user_id, username) <> 'none')
    where user_id = p_user_id;
  end if;

  -- Para yatırma / çekme kısıtlaması (kendi hesabı dahil serbest;
  -- kilitlenme riski yoktur, kullanıcı kendi kısıtını kaldırabilir).
  if p_deposit_blocked is not null or p_withdraw_blocked is not null then
    if not v_super and not public.has_admin_permission(v_caller, 'restrict_money') then
      raise exception 'yetkisiz işlem: para işlemleri kısıtlama yetkisi gerekli';
    end if;
    update public.profiles
    set deposit_blocked = coalesce(p_deposit_blocked, deposit_blocked),
        withdraw_blocked = coalesce(p_withdraw_blocked, withdraw_blocked)
    where id = p_user_id;
  end if;
end;
$$;

revoke all on function public.admin_update_profile(uuid, numeric, boolean, boolean, boolean, text[], boolean, boolean) from public;
grant execute on function public.admin_update_profile(uuid, numeric, boolean, boolean, boolean, text[], boolean, boolean) to authenticated;

-- ------------------------------------------------------------
-- 5) Forum onay rozeti: yazar süper adminse veya sistem hesabı
--    `deniztradex` ise otomatik işaretlenir. İstemci değeri ezilir.
-- ------------------------------------------------------------
alter table public.forum_posts
  add column if not exists is_verified boolean not null default false;

alter table public.forum_replies
  add column if not exists is_verified boolean not null default false;

create or replace function public.sync_forum_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin boolean := false;
begin
  select (p.is_admin = true) into v_admin
  from public.profiles as p
  where p.id = NEW.user_id;

  NEW.is_verified :=
    coalesce(v_admin, false)
    or lower(coalesce(NEW.username, '')) = 'deniztradex';

  return NEW;
end;
$$;

drop trigger if exists forum_posts_verified_trigger on public.forum_posts;
create trigger forum_posts_verified_trigger
  before insert or update of username, user_id on public.forum_posts
  for each row execute function public.sync_forum_verified();

drop trigger if exists forum_replies_verified_trigger on public.forum_replies;
create trigger forum_replies_verified_trigger
  before insert or update of username, user_id on public.forum_replies
  for each row execute function public.sync_forum_verified();

-- Mevcut satırları geriye dönük işaretle (idempotent).
update public.forum_posts as p
set is_verified = true
where p.is_verified = false
  and (
    lower(p.username) = 'deniztradex'
    or exists (
      select 1 from public.profiles as pr
      where pr.id = p.user_id and pr.is_admin = true
    )
  );

update public.forum_replies as r
set is_verified = true
where r.is_verified = false
  and (
    lower(r.username) = 'deniztradex'
    or exists (
      select 1 from public.profiles as pr
      where pr.id = r.user_id and pr.is_admin = true
    )
  );
