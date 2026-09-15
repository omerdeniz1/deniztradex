-- ============================================================
-- DenizTradeX � TEK SEFERDE UYGULANACAK TOPLU SQL
-- Supabase Dashboard � SQL Editor � New Query � yap��t�r � Run
-- T�m ifadeler idempotent: daha �nce k�smen uyguland�ysa bile g�venle tekrar �al���r.
-- ============================================================


-- >>> supabase/migrations/20260915090000_login_fallback.sql
-- ============================================================
-- DenizTradeX — login dayanıklılığı (Safari logout/login fix)
--
-- Kök neden: `profiles_select_own` politikası anonim (çıkış yapmış)
-- kullanıcıların `profiles` tablosunu okumasını engelliyordu. Login
-- ekranı kullanıcı adından e-postayı BULMAK İÇİN girişten ÖNCE
-- `profiles` okuması yapıyordu; bu okuma anon iken RLS tarafından
-- her zaman reddedildiği için "Kullanıcı bulunamadı" hatası
-- alınıyordu (özellikle Safari mobilde, signOut tamamlanınca).
--
-- Çözüm: giriş öncesi kullanıcı adı -> e-posta çözümlemesi için
-- RLS'yi baypas eden, yalnızca e-postayı döndüren SECURITY DEFINER
-- bir RPC fonksiyonu. E-posta zaten girişin kamuya açık
-- tanımlayıcısıdır (şifre olmadan tek başına işe yaramaz).
-- ============================================================

-- Kullanıcı adı / e-posta aramalarını büyük-küçük harf duyarsız ve
-- hızlı yapmak için yardımcı indexler.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

-- ------------------------------------------------------------
-- handle_new_user: çakışmalara dayanıklı hale getir.
-- Aynı id tekrar tetiklenirse (retry / yeniden deneme) sessizce
-- geç; kullanıcı adı çakışırsa benzersiz bir suffix ekle ki kayıt
-- asla profiles satırı olmadan kalmasın.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username text;
  final_username   text;
begin
  desired_username := nullif(btrim(coalesce(new.raw_user_meta_data->>'username', '')), '');
  if desired_username is null then
    desired_username := 'user_' || left(new.id::text, 8);
  end if;

  final_username := desired_username;

  begin
    insert into public.profiles (id, username, email, balance)
    values (new.id, final_username, coalesce(new.email, ''), 10000.00);
  exception
    when unique_violation then
      -- Aynı kullanıcı adı alınmışsa suffix dene, aynı id ise yoksay.
      begin
        final_username := left(desired_username, 40) || '_' || left(new.id::text, 8);
        insert into public.profiles (id, username, email, balance)
        values (new.id, final_username, coalesce(new.email, ''), 10000.00);
      exception
        when unique_violation then
          null; -- satır zaten var, sessizce geç
      end;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- resolve_login_email: giriş öncesi kullanıcı adı/e-posta -> e-posta
-- çözümlemesi. SECURITY DEFINER olduğu için anonim kullanıcılar da
-- çağırabilir; yalnızca eşleşen satırın e-postasını döndürür,
-- başka hiçbir kolon sızdırmaz.
-- ------------------------------------------------------------
create or replace function public.resolve_login_email(p_login text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_login is null or btrim(p_login) = '' then
    return null;
  end if;

  select p.email into v_email
  from public.profiles as p
  where lower(p.username) = lower(btrim(p_login))
     or lower(p.email) = lower(btrim(p_login))
  limit 1;

  return v_email;
end;
$$;

revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;


-- >>> supabase/migrations/20260915100000_promo_single_use.sql
-- ============================================================
-- DenizTradeX — promosyonlar hesap bazında tek kullanımlık
--
-- Sorun: promosyon kullanımı yalnızca cihazın localStorage'ında
-- tutuluyordu; aynı hesap mobilden alıp masaüstünden tekrar
-- alabiliyordu.
--
-- Çözüm: `profiles.used_promos` dizisi + satır kilitli
-- `claim_promo` RPC'si. İki cihaz aynı anda istese bile satır
-- kilidi (FOR UPDATE) sıralar; ikinci istek `false` alır ve
-- bakiye iki kez işlenmez.
-- ============================================================

alter table public.profiles
  add column if not exists used_promos text[] not null default '{}';

create or replace function public.claim_promo(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_arr  text[];
begin
  if v_uid is null or v_code = '' then
    return false;
  end if;

  -- Hesap satırını kilitle: eşzamanlı iki claim sıralanır.
  select coalesce(used_promos, '{}') into v_arr
  from public.profiles
  where id = v_uid
  for update;

  if not found then
    return false;
  end if;

  if v_code = any (v_arr) then
    return false; -- bu hesap daha önce kullandı
  end if;

  update public.profiles
  set used_promos = v_arr || v_code
  where id = v_uid;

  return true;
end;
$$;

revoke all on function public.claim_promo(text) from public;
grant execute on function public.claim_promo(text) to authenticated;


-- >>> supabase/migrations/20260915110000_forum.sql
-- ============================================================
-- DenizTradeX — Forum (Topluluk) sekmesi
--
-- `forum_posts`: kullanıcı gönderileri (280 karakter, X tarzı).
-- `forum_likes`: beğeniler; `like_count` tetikleyici ile tutulur.
-- `toggle_forum_like`: atomik beğen/geri-al (tek roundtrip).
-- ============================================================

create table if not exists public.forum_posts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  username   text not null,
  content    text not null check (char_length(content) between 1 and 280),
  like_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists forum_posts_created_at_idx
  on public.forum_posts (created_at desc);

create index if not exists forum_posts_user_id_idx
  on public.forum_posts (user_id);

create table if not exists public.forum_likes (
  post_id    uuid not null references public.forum_posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists forum_likes_user_id_idx
  on public.forum_likes (user_id);

alter table public.forum_posts enable row level security;
alter table public.forum_likes  enable row level security;

-- Herkes okur (topluluk akışı herkese açık).
drop policy if exists forum_posts_select_all on public.forum_posts;
create policy forum_posts_select_all
  on public.forum_posts for select
  using (true);

-- Yalnızca kendi adına yazabilir / silebilir.
drop policy if exists forum_posts_insert_own on public.forum_posts;
create policy forum_posts_insert_own
  on public.forum_posts for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_posts_delete_own on public.forum_posts;
create policy forum_posts_delete_own
  on public.forum_posts for delete
  using (auth.uid() = user_id);

drop policy if exists forum_likes_select_all on public.forum_likes;
create policy forum_likes_select_all
  on public.forum_likes for select
  using (true);

drop policy if exists forum_likes_insert_own on public.forum_likes;
create policy forum_likes_insert_own
  on public.forum_likes for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_likes_delete_own on public.forum_likes;
create policy forum_likes_delete_own
  on public.forum_likes for delete
  using (auth.uid() = user_id);

grant select on public.forum_posts to anon, authenticated;
grant insert, delete on public.forum_posts to authenticated;
grant select, insert, delete on public.forum_likes to authenticated;

-- ------------------------------------------------------------
-- like_count bakım tetikleyicisi (istemci sayaç yazamaz —
-- update politikası yok; yalnızca bu definer fonksiyon yazar).
-- ------------------------------------------------------------
create or replace function public.sync_forum_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.forum_posts
    set like_count = (select count(*) from public.forum_likes where post_id = OLD.post_id)
    where id = OLD.post_id;
    return OLD;
  end if;
  update public.forum_posts
  set like_count = (select count(*) from public.forum_likes where post_id = NEW.post_id)
  where id = NEW.post_id;
  return NEW;
end;
$$;

drop trigger if exists forum_likes_count_trigger on public.forum_likes;
create trigger forum_likes_count_trigger
  after insert or delete on public.forum_likes
  for each row execute function public.sync_forum_like_count();

-- ------------------------------------------------------------
-- Atomik beğen/geri-al: satır kilidi + tek işlem. Dönen JSON:
-- {"liked": true|false, "like_count": n}
-- ------------------------------------------------------------
create or replace function public.toggle_forum_like(p_post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_liked  boolean;
  v_count  integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('liked', false, 'like_count', 0);
  end if;

  perform 1 from public.forum_posts where id = p_post_id for update;
  if not found then
    return jsonb_build_object('liked', false, 'like_count', 0);
  end if;

  if exists (
    select 1 from public.forum_likes where post_id = p_post_id and user_id = v_uid
  ) then
    delete from public.forum_likes where post_id = p_post_id and user_id = v_uid;
    v_liked := false;
  else
    insert into public.forum_likes (post_id, user_id) values (p_post_id, v_uid);
    v_liked := true;
  end if;

  select like_count into v_count from public.forum_posts where id = p_post_id;
  return jsonb_build_object('liked', v_liked, 'like_count', coalesce(v_count, 0));
end;
$$;

revoke all on function public.toggle_forum_like(uuid) from public;
grant execute on function public.toggle_forum_like(uuid) to authenticated;


-- >>> supabase/migrations/20260915120000_forum_replies.sql
-- ============================================================
-- DenizTradeX — Forum yanıtları (replies)
--
-- `forum_replies`: gönderi altı yanıt dizisi. `reply_count`
-- tetikleyici ile `forum_posts` üzerinde tutulur.
-- ============================================================

alter table public.forum_posts
  add column if not exists reply_count integer not null default 0;

create table if not exists public.forum_replies (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.forum_posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  username   text not null,
  content    text not null check (char_length(content) between 1 and 280),
  created_at timestamptz not null default now()
);

create index if not exists forum_replies_post_id_idx
  on public.forum_replies (post_id, created_at asc);

create index if not exists forum_replies_user_id_idx
  on public.forum_replies (user_id);

alter table public.forum_replies enable row level security;

drop policy if exists forum_replies_select_all on public.forum_replies;
create policy forum_replies_select_all
  on public.forum_replies for select
  using (true);

drop policy if exists forum_replies_insert_own on public.forum_replies;
create policy forum_replies_insert_own
  on public.forum_replies for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_replies_delete_own on public.forum_replies;
create policy forum_replies_delete_own
  on public.forum_replies for delete
  using (auth.uid() = user_id);

grant select on public.forum_replies to anon, authenticated;
grant insert, delete on public.forum_replies to authenticated;

-- ------------------------------------------------------------
-- reply_count bakım tetikleyicisi
-- ------------------------------------------------------------
create or replace function public.sync_forum_reply_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.forum_posts
    set reply_count = (select count(*) from public.forum_replies where post_id = OLD.post_id)
    where id = OLD.post_id;
    return OLD;
  end if;
  update public.forum_posts
  set reply_count = (select count(*) from public.forum_replies where post_id = NEW.post_id)
  where id = NEW.post_id;
  return NEW;
end;
$$;

drop trigger if exists forum_replies_count_trigger on public.forum_replies;
create trigger forum_replies_count_trigger
  after insert or delete on public.forum_replies
  for each row execute function public.sync_forum_reply_count();

-- Varsa eski satırların sayaçlarını düzelt (idempotent).
update public.forum_posts as p
set reply_count = coalesce(
  (select count(*) from public.forum_replies as r where r.post_id = p.id),
  0
);


-- >>> supabase/migrations/20260915130000_forum_realtime.sql
-- ============================================================
-- DenizTradeX — Forum realtime (canlı akış)
--
-- `forum_posts` / `forum_replies` / `forum_likes` değişiklikleri
-- diğer cihazlara anında (<1 sn) düşsün diye tablolar
-- `supabase_realtime` yayınına eklenir. Yayın kapalıysa uygulama
-- yalnızca periyodik yoklamaya kalır (≈10-15 sn gecikme).
-- Idempotent: tablo zaten yayındaysa atlanır.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'forum_posts'
  ) then
    alter publication supabase_realtime add table public.forum_posts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'forum_replies'
  ) then
    alter publication supabase_realtime add table public.forum_replies;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'forum_likes'
  ) then
    alter publication supabase_realtime add table public.forum_likes;
  end if;
end;
$$;


-- >>> supabase/migrations/20260915140000_admin.sql
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

