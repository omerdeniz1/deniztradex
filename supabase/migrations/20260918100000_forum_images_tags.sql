-- ============================================================
-- DenizTradeX — Forum fotoğrafı + isim altı etiketi
--
-- 1) `profiles.user_tag` (max 24): Ayarlar → Kullanıcı Adı Değiştir
--    ekranından düzenlenir, forumda isim altında rozet gibi görünür.
-- 2) `forum_posts.user_tag` / `forum_replies.user_tag`: yazı anında
--    profilden damgalanır; kullanıcı adı değişince eski yazılar
--    tetikleyiciyle tazelenir (avatar mekaniğiyle aynı).
-- 3) `forum_posts.image_url` / `forum_replies.image_url`: gönderiye
--    eklenen fotoğrafın herkese-açık adresi (max 10MB, istemcide
--    denetlenir; twitter tarzı metin + fotoğraf).
-- 4) `storage.forum-images` herkese-açık okunur kova: giriş yapmış
--    kullanıcılar yalnızca kendi klasörlerine (`<uid>/...`)
--    yazabilir/silebilir.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Profil etiketi
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists user_tag text;

-- ------------------------------------------------------------
-- 2) Yazı damgaları: etiket + fotoğraf
-- ------------------------------------------------------------
alter table public.forum_posts
  add column if not exists user_tag text;

alter table public.forum_posts
  add column if not exists image_url text;

alter table public.forum_replies
  add column if not exists user_tag text;

alter table public.forum_replies
  add column if not exists image_url text;

-- Yazı tetikleyicisini etiketle genişlet (rozet + avatar aynen korunur).
create or replace function public.sync_forum_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avatar text;
  v_tag text;
begin
  select p.avatar_url, p.user_tag into v_avatar, v_tag
  from public.profiles as p
  where p.id = NEW.user_id;

  NEW.verified_tier := public.forum_verified_tier(NEW.user_id, NEW.username);
  NEW.is_verified := (NEW.verified_tier <> 'none');
  NEW.avatar_url := v_avatar;
  -- İstemci bilerek etiket gönderdiyse onu koru, yoksa profilden damgala.
  if NEW.user_tag is null then
    NEW.user_tag := v_tag;
  end if;

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

-- Kullanıcı adı / etiket değişince eski yazılara yay.
create or replace function public.sync_profile_forum_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.username is distinct from OLD.username
     or NEW.user_tag is distinct from OLD.user_tag then
    update public.forum_posts
    set username = NEW.username,
        user_tag = NEW.user_tag
    where user_id = NEW.id;

    update public.forum_replies
    set username = NEW.username,
        user_tag = NEW.user_tag
    where user_id = NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_forum_identity_cascade on public.profiles;
create trigger profiles_forum_identity_cascade
  after update of username, user_tag on public.profiles
  for each row execute function public.sync_profile_forum_identity();

-- Mevcut yazılara geriye dönük etiket işle (idempotent).
update public.forum_posts as p
set user_tag = pr.user_tag
from public.profiles as pr
where pr.id = p.user_id
  and p.user_tag is distinct from pr.user_tag;

update public.forum_replies as r
set user_tag = pr.user_tag
from public.profiles as pr
where pr.id = r.user_id
  and r.user_tag is distinct from pr.user_tag;

-- ------------------------------------------------------------
-- 3) Forum fotoğraf kovası + politikaları
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('forum-images', 'forum-images', true)
on conflict (id) do update set public = true;

drop policy if exists forum_images_public_read on storage.objects;
create policy forum_images_public_read
  on storage.objects for select
  using (bucket_id = 'forum-images');

drop policy if exists forum_images_insert_own on storage.objects;
create policy forum_images_insert_own
  on storage.objects for insert
  with check (
    bucket_id = 'forum-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists forum_images_update_own on storage.objects;
create policy forum_images_update_own
  on storage.objects for update
  using (
    bucket_id = 'forum-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'forum-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists forum_images_delete_own on storage.objects;
create policy forum_images_delete_own
  on storage.objects for delete
  using (
    bucket_id = 'forum-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
