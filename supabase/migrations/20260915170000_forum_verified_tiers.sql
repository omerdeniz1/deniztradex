-- ============================================================
-- DenizTradeX — Forum rozet seviyeleri (sarı + mavi tik)
--
-- `forum_posts.verified_tier` / `forum_replies.verified_tier`:
--   'super' → sarı tik (süper admin veya sistem hesabı deniztradex),
--   'admin' → mavi tik (izinli alt yönetici),
--   'none'  → rozetsiz (normal kullanıcı).
--
-- Karar sunucuda verilir (`forum_verified_tier` yardımcısı +
-- tetikleyici); istemcinin gönderdiği değer ezilir. Yönetici yetkisi
-- değişince (`admin_update_profile`) yazarın eski yazılarının
-- rozetleri de tazelenir. Eski `is_verified` kolonu geriye uyumluluk
-- için yazılmaya devam eder (tier <> 'none' demek).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.forum_posts
  add column if not exists verified_tier text not null default 'none';

alter table public.forum_replies
  add column if not exists verified_tier text not null default 'none';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'forum_posts_verified_tier_check'
  ) then
    alter table public.forum_posts
      add constraint forum_posts_verified_tier_check
      check (verified_tier in ('none', 'admin', 'super'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'forum_replies_verified_tier_check'
  ) then
    alter table public.forum_replies
      add constraint forum_replies_verified_tier_check
      check (verified_tier in ('none', 'admin', 'super'));
  end if;
end;
$$;

-- ------------------------------------------------------------
-- Rozet yardımcısı: tek doğruluk kaynağı (tetikleyici + RPC ortak).
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
-- Tetikleyici: yazı eklenirken/güncellenirken rozeti damgala.
-- ------------------------------------------------------------
create or replace function public.sync_forum_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  NEW.verified_tier := public.forum_verified_tier(NEW.user_id, NEW.username);
  NEW.is_verified := (NEW.verified_tier <> 'none');
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

-- ------------------------------------------------------------
-- Geriye dönük işaretle (idempotent): önce süper, sonra alt yönetici.
-- ------------------------------------------------------------
update public.forum_posts as p
set verified_tier = 'super',
    is_verified = true
where p.verified_tier <> 'super'
  and (
    lower(p.username) = 'deniztradex'
    or exists (
      select 1 from public.profiles as pr
      where pr.id = p.user_id and pr.is_admin = true
    )
  );

update public.forum_replies as r
set verified_tier = 'super',
    is_verified = true
where r.verified_tier <> 'super'
  and (
    lower(r.username) = 'deniztradex'
    or exists (
      select 1 from public.profiles as pr
      where pr.id = r.user_id and pr.is_admin = true
    )
  );

update public.forum_posts as p
set verified_tier = 'admin',
    is_verified = true
where p.verified_tier = 'none'
  and exists (
    select 1 from public.profiles as pr
    where pr.id = p.user_id
      and coalesce(array_length(pr.admin_permissions, 1), 0) > 0
  );

update public.forum_replies as r
set verified_tier = 'admin',
    is_verified = true
where r.verified_tier = 'none'
  and exists (
    select 1 from public.profiles as pr
    where pr.id = r.user_id
      and coalesce(array_length(pr.admin_permissions, 1), 0) > 0
  );
