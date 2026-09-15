-- ============================================================
-- DenizTradeX — Profil fotoğrafı (avatar) + forum moderasyonu
--
-- 1) `storage.avatars` herkese-açık okunur kova: kullanıcılar yalnızca
--    kendi klasörlerine (`<uid>/...`) yazabilir/silebilir.
-- 2) `forum_posts.avatar_url` / `forum_replies.avatar_url`: yazı
--    anında profilden kopyalanır (sahtecilik imkânsız), profil fotoğrafı
--    değişince eski yazılar tetikleyiciyle tazelenir.
-- 3) Forum silme yetkisi: süper admin veya `ban_users` izni olan alt
--    yönetici TÜM yazı/yanıtları silebilir (beğeniler + yanıtlar
--    FK cascade ile birlikte silinir).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Avatar kovası + politikaları
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ------------------------------------------------------------
-- 2) Forum yazılarına avatar damgası
-- ------------------------------------------------------------
alter table public.forum_posts
  add column if not exists avatar_url text;

alter table public.forum_replies
  add column if not exists avatar_url text;

-- Yazı tetikleyicisini avatarla genişlet (rozet mantığı aynen korunur).
create or replace function public.sync_forum_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avatar text;
begin
  select p.avatar_url into v_avatar
  from public.profiles as p
  where p.id = NEW.user_id;

  NEW.verified_tier := public.forum_verified_tier(NEW.user_id, NEW.username);
  NEW.is_verified := (NEW.verified_tier <> 'none');
  NEW.avatar_url := v_avatar;

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

-- Profil fotoğrafı değişince eski yazılara yay.
create or replace function public.sync_profile_avatar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.avatar_url is distinct from OLD.avatar_url then
    update public.forum_posts
    set avatar_url = NEW.avatar_url
    where user_id = NEW.id;

    update public.forum_replies
    set avatar_url = NEW.avatar_url
    where user_id = NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_avatar_cascade on public.profiles;
create trigger profiles_avatar_cascade
  after update of avatar_url on public.profiles
  for each row execute function public.sync_profile_avatar();

-- Mevcut yazılara geriye dönük avatar işle (idempotent).
update public.forum_posts as p
set avatar_url = pr.avatar_url
from public.profiles as pr
where pr.id = p.user_id
  and p.avatar_url is distinct from pr.avatar_url;

update public.forum_replies as r
set avatar_url = pr.avatar_url
from public.profiles as pr
where pr.id = r.user_id
  and r.avatar_url is distinct from pr.avatar_url;

-- ------------------------------------------------------------
-- 3) Forum moderasyon silme politikaları (süper admin veya
--    `ban_users` izinli alt yönetici tüm satırları silebilir).
-- ------------------------------------------------------------
drop policy if exists forum_posts_admin_delete on public.forum_posts;
create policy forum_posts_admin_delete
  on public.forum_posts for delete
  using (
    public.is_admin()
    or public.has_admin_permission(auth.uid(), 'ban_users')
  );

drop policy if exists forum_replies_admin_delete on public.forum_replies;
create policy forum_replies_admin_delete
  on public.forum_replies for delete
  using (
    public.is_admin()
    or public.has_admin_permission(auth.uid(), 'ban_users')
  );
