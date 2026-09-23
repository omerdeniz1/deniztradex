-- ============================================================
-- DenizTradeX — Forum profilleri (Twitter tarzı) + takipçi + beğeni tabanı
--
-- 1) PROFİLLER: `profiles.bio` (tanıtım yazısı) + `profiles.follower_base`
--    (senaryo tabanı — gerçek takipler ÜSTÜNE eklenir, asla düşmez).
-- 2) TAKİP: `forum_follows` (takipçi → takip edilen kullanıcı adı).
--    Kullanıcı adı metinle tutulur — persona hesaplar (auth satırı
--    olmayan senaryo hesapları) da takip edilebilir. `follow_user` /
--    `unfollow_user` RPC'leri sayacı döndürür; `get_public_profile`
--    tek çağrıda profil + sayılar + takip durumu verir (herkese açık).
-- 3) PERSONALAR: `persona_profiles` — platformun senaryo hesapları
--    (resmi hesap + iki analist). Takipçi tabanları sabittir:
--      DenizTradeXx            1.700.000 (resmi, sarı tik)
--      omerbabaparayapmakta      800.000 (analist, mavi tik)
--      blackrock                 780.000 (analist, mavi tik)
-- 4) BEĞENİ TABANI: `forum_posts.base_likes` — persona gönderileri
--    10-20 bin beğeniyle başlar; gerçek beğeniler ÜSTÜNE eklenir
--    (`sync_forum_like_count` artık taban + gerçek yazar, SIFIRLAMAZ).
--    `post_bot_message` persona adına mesajda tabanı otomatik atar.
-- 5) KULLANICI ADI: `is_username_available` — kayıttaki "dolu"
--    kontrolünün sunucu tarafı, RLS-körü olmayan hali (anon de
--    çağırabilir; yalnızca true/false döner).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Profil alanları
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists bio text not null default '';

alter table public.profiles
  add column if not exists follower_base bigint not null default 0
    check (follower_base >= 0);

-- ------------------------------------------------------------
-- 2) Takip tablosu
-- ------------------------------------------------------------
create table if not exists public.forum_follows (
  id                 uuid primary key default gen_random_uuid(),
  follower_id        uuid not null references auth.users (id) on delete cascade,
  following_username text not null check (char_length(following_username) between 1 and 64),
  created_at         timestamptz not null default now(),
  unique (follower_id, following_username)
);

create index if not exists forum_follows_following_idx
  on public.forum_follows (following_username);

create index if not exists forum_follows_follower_idx
  on public.forum_follows (follower_id);

alter table public.forum_follows enable row level security;

-- Takip grafiği herkese açık vitrin (sayaçlar girişsiz de görünür).
drop policy if exists forum_follows_select_all on public.forum_follows;
create policy forum_follows_select_all
  on public.forum_follows for select
  to anon, authenticated
  using (true);

drop policy if exists forum_follows_insert_own on public.forum_follows;
create policy forum_follows_insert_own
  on public.forum_follows for insert
  to authenticated
  with check (auth.uid() = follower_id);

drop policy if exists forum_follows_delete_own on public.forum_follows;
create policy forum_follows_delete_own
  on public.forum_follows for delete
  to authenticated
  using (auth.uid() = follower_id);

grant select on public.forum_follows to anon, authenticated;
grant insert, delete on public.forum_follows to authenticated;

-- ------------------------------------------------------------
-- 3) Persona hesapları (senaryo: resmi + iki analist)
-- ------------------------------------------------------------
create table if not exists public.persona_profiles (
  username      text primary key,
  display_name  text not null,
  bio           text not null default '',
  avatar_url    text,
  follower_base bigint not null default 0 check (follower_base >= 0),
  verified_tier text not null default 'admin'
    check (verified_tier in ('none', 'admin', 'super')),
  created_at    timestamptz not null default now()
);

alter table public.persona_profiles enable row level security;

drop policy if exists persona_profiles_select_all on public.persona_profiles;
create policy persona_profiles_select_all
  on public.persona_profiles for select
  to anon, authenticated
  using (true);

grant select on public.persona_profiles to anon, authenticated;

insert into public.persona_profiles (username, display_name, bio, follower_base, verified_tier)
values
  ('DenizTradeXx',
   'DenizTradeX',
   'DenizTradeX resmi hesabı — duyurular, listelemeler ve piyasa notları buradan paylaşılır.',
   1700000,
   'super'),
  ('omerbabaparayapmakta',
   'Ömer Baba',
   'Kripto analisti — piyasa yapısı, likidite haritaları ve döngü notları. Yatırım tavsiyesi değildir.',
   800000,
   'admin'),
  ('blackrock',
   'BlackRock',
   'Kurumsal kripto masası parodisi — ETF akımları, makro ve risk iştahı notları. Yatırım tavsiyesi değildir.',
   780000,
   'admin')
on conflict (username) do update set
  display_name  = excluded.display_name,
  bio           = excluded.bio,
  follower_base = excluded.follower_base,
  verified_tier = excluded.verified_tier;

-- ------------------------------------------------------------
-- 4) Beğeni tabanı (persona gönderileri 10-20 binle başlar)
-- ------------------------------------------------------------
alter table public.forum_posts
  add column if not exists base_likes integer not null default 0
    check (base_likes >= 0);

-- Beğeni sayacı: taban + gerçek (gerçek beğeni tabanı SIFIRLAMAZ).
create or replace function public.sync_forum_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base integer := 0;
  v_post uuid;
begin
  if TG_OP = 'DELETE' then
    v_post := OLD.post_id;
  else
    v_post := NEW.post_id;
  end if;
  select coalesce(base_likes, 0) into v_base
  from public.forum_posts
  where id = v_post;
  update public.forum_posts
  set like_count = coalesce(v_base, 0)
    + (select count(*) from public.forum_likes where post_id = v_post)
  where id = v_post;
  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

-- Mevcut persona gönderilerine geriye dönük taban (10-20 bin arası):
-- like_count = taban + gerçek beğeni (gerçekler korunur).
do $$
declare
  r record;
  v_base integer;
  v_real integer;
begin
  for r in
    select id from public.forum_posts
    where lower(username) in ('deniztradexx', 'omerbabaparayapmakta', 'blackrock')
      and coalesce(base_likes, 0) = 0
  loop
    v_base := 10000 + floor(random() * 10001)::integer;
    select count(*) into v_real from public.forum_likes where post_id = r.id;
    update public.forum_posts
    set base_likes = v_base,
        like_count = v_base + coalesce(v_real, 0)
    where id = r.id;
  end loop;
end;
$$;

-- Bot mesajı: persona adına atılan gönderi tabanla başlar (10-20 bin).
create or replace function public.post_bot_message(
  p_username   text,
  p_content    text,
  p_fake_likes integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_base integer := 0;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin bot çalıştırabilir';
  end if;

  if coalesce(trim(p_username), '') = '' then
    raise exception 'geçersiz bot adı';
  end if;
  if coalesce(trim(p_content), '') = '' then
    raise exception 'geçersiz mesaj';
  end if;
  if char_length(p_content) > 500 then
    raise exception 'mesaj en fazla 500 karakter olabilir';
  end if;

  -- Persona senaryo hesapları beğeni tabanıyla başlar (10-20 bin).
  if lower(trim(p_username)) in
     ('deniztradexx', 'omerbabaparayapmakta', 'blackrock') then
    v_base := 10000 + floor(random() * 10001)::integer;
  end if;

  insert into public.forum_posts (user_id, username, content, like_count, base_likes)
  values (v_uid, trim(p_username), trim(p_content),
          greatest(coalesce(p_fake_likes, 0), 0) + v_base, v_base)
  returning id into v_id;

  update public.forum_posts
    set verified_tier = 'admin',
        is_verified = true,
        avatar_url = null
    where id = v_id;

  return v_id;
end;
$$;

-- Persona rozetleri: resmi hesap sarı, analistler mavi tik.
create or replace function public.forum_verified_tier(p_user_id uuid, p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when translate(lower(trim(coalesce(p_username, ''))), 'İI' || chr(775), 'iı')
      in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı') then 'admin'
    when lower(trim(coalesce(p_username, ''))) in ('deniztradex', 'deniztradexx') then 'super'
    when lower(trim(coalesce(p_username, ''))) in ('omerbabaparayapmakta', 'blackrock') then 'admin'
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

-- ------------------------------------------------------------
-- 5) Takip RPC'leri
-- ------------------------------------------------------------
create or replace function public.follow_user(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target text := lower(trim(coalesce(p_username, '')));
  v_own text;
begin
  if v_uid is null then
    raise exception 'giriş gerekli';
  end if;
  if v_target = '' then
    raise exception 'geçersiz kullanıcı';
  end if;
  select lower(username) into v_own from public.profiles where id = v_uid;
  if v_own is not null and v_own = v_target then
    raise exception 'kendini takip edemezsin';
  end if;
  insert into public.forum_follows (follower_id, following_username)
  values (v_uid, v_target)
  on conflict (follower_id, following_username) do nothing;
  return jsonb_build_object('ok', true, 'following', true);
end;
$$;

revoke all on function public.follow_user(text) from public;
grant execute on function public.follow_user(text) to authenticated;

create or replace function public.unfollow_user(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target text := lower(trim(coalesce(p_username, '')));
begin
  if v_uid is null then
    raise exception 'giriş gerekli';
  end if;
  delete from public.forum_follows
  where follower_id = v_uid and following_username = v_target;
  return jsonb_build_object('ok', true, 'following', false);
end;
$$;

revoke all on function public.unfollow_user(text) from public;
grant execute on function public.unfollow_user(text) to authenticated;

-- Herkese açık profil kartı: persona önce, sonra gerçek profil.
-- Takipçi = taban + gerçek (gerçek takip tabanı DÜŞÜRMEZ).
create or replace function public.get_public_profile(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text := lower(trim(coalesce(p_username, '')));
  v_uid uuid := auth.uid();
  v_persona public.persona_profiles%rowtype;
  v_profile public.profiles%rowtype;
  v_base bigint := 0;
  v_tier text := 'none';
  v_name text;
  v_bio text := '';
  v_avatar text := null;
  v_created timestamptz := null;
  v_followers bigint;
  v_following bigint;
  v_posts bigint;
  v_is_following boolean := false;
begin
  if v_key = '' then
    return null;
  end if;

  select * into v_persona
  from public.persona_profiles
  where lower(username) = v_key;

  if found then
    v_name := v_persona.display_name;
    v_bio := coalesce(v_persona.bio, '');
    v_avatar := v_persona.avatar_url;
    v_base := coalesce(v_persona.follower_base, 0);
    v_tier := coalesce(v_persona.verified_tier, 'admin');
    v_created := v_persona.created_at;
  else
    select * into v_profile
    from public.profiles
    where lower(username) = v_key;
    if not found then
      return null;
    end if;
    v_name := v_profile.username;
    v_bio := coalesce(v_profile.bio, '');
    v_avatar := v_profile.avatar_url;
    v_base := coalesce(v_profile.follower_base, 0);
    v_tier := public.forum_verified_tier(v_profile.id, v_profile.username);
    v_created := v_profile.created_at;
  end if;

  select count(*) into v_followers
  from public.forum_follows
  where following_username = v_key;

  -- Takip edilen sayısı: bu hesabın takip ettikleri (gerçek satırlar).
  -- Personanın auth satırı olmadığı için vitrinde 0 görünür.
  if v_persona.username is null then
    select count(*) into v_following
    from public.forum_follows
    where follower_id = (
      select id from public.profiles where lower(username) = v_key
    );
  else
    v_following := 0;
  end if;

  if v_uid is not null then
    select exists (
      select 1 from public.forum_follows
      where follower_id = v_uid and following_username = v_key
    ) into v_is_following;
  end if;

  select count(*) into v_posts
  from public.forum_posts
  where lower(username) = v_key;

  return jsonb_build_object(
    'ok', true,
    'username', v_name,
    'handle', v_key,
    'bio', v_bio,
    'avatar_url', v_avatar,
    'verified_tier', v_tier,
    'created_at', v_created,
    'followers', v_base + coalesce(v_followers, 0),
    'following', coalesce(v_following, 0),
    'posts', coalesce(v_posts, 0),
    'is_following', coalesce(v_is_following, false),
    'is_persona', (v_persona.username is not null)
  );
end;
$$;

revoke all on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 6) Kullanıcı adı uygunluğu (kayıt öncesi sunucu kontrolü)
-- ------------------------------------------------------------
create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles
    where lower(username) = lower(trim(coalesce(p_username, '')))
  );
$$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;
