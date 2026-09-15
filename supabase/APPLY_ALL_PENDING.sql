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


-- >>> supabase/migrations/20260915150000_admin_rbac.sql
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


-- >>> supabase/migrations/20260915160000_rls_hardening.sql
-- ============================================================
-- DenizTradeX — RLS sıkılaştırma (profil sızıntısı kapatma)
--
-- Durum: `profiles` tablosu anonim anahtarla herkese açık okunuyordu
-- (tüm kullanıcıların e-posta + bakiyeleri sızıyordu). Bu dosya tabloyu
-- tasarım durumuna döndürür:
--   - SELECT/UPDATE: yalnızca kendi satırı + yöneticiler,
--   - INSERT: yalnızca kendi satırı (upsert dayanıklılığı için),
--   - DELETE: kimse (varsayılan ret),
--   - Ayrıcalık kolonları INSERT'te de korunur (kendini admin yapma
--     koruması INSERT yolunu da kapatır).
--
-- Bilinmeyen adlı, herkese açık politikalar pg_policies üzerinden
-- temizlenir; iyi bilinen politikalar korunur. RLS tüm tablolarda
-- zorunlu kılınır. Uygulama akışları (anon giriş-öncesi RPC, kendi
-- satırı okuma/yazma, admin paneli) bu kuralla birebir uyumludur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) profiles: izin listesindeki politikalar dışındaki tüm
--    SELECT/UPDATE/INSERT/DELETE politikalarını kaldır.
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select policyname, cmd from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
  loop
    if r.cmd = 'SELECT' and r.policyname not in ('profiles_select_own', 'profiles_admin_select') then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    elsif r.cmd = 'UPDATE' and r.policyname not in ('profiles_update_own', 'profiles_admin_update') then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    elsif r.cmd = 'INSERT' and r.policyname not in ('profiles_insert_own') then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    elsif r.cmd = 'DELETE' then
      execute format('drop policy if exists %I on public.profiles', r.policyname);
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 2) Kendi-satırı politikaları (init ile birebir) + upsert için
--    INSERT politikası.
-- ------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles for insert
  with check (auth.uid() = id);

-- Admin politikaları (yoksa kur, varsa tazele).
drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select
  on public.profiles for select
  using (public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- 3) INSERT ayrıcalık koruması: yönetici olmayan hiç kimse satır
--    oluştururken is_admin / is_frozen / is_banned /
--    admin_permissions değerlerini yükseltemez (varsayılanlara çekilir).
-- ------------------------------------------------------------
create or replace function public.protect_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    NEW.is_admin := false;
    NEW.is_frozen := false;
    NEW.is_banned := false;
    NEW.admin_permissions := '{}';
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_insert_guard on public.profiles;
create trigger profiles_insert_guard
  before insert on public.profiles
  for each row execute function public.protect_profile_insert();

-- ------------------------------------------------------------
-- 4) Defter tabloları: kendi-satırı + admin okuma (init ile birebir).
-- ------------------------------------------------------------
drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own
  on public.transactions for select
  using (auth.uid() = user_id);

drop policy if exists transactions_insert_own on public.transactions;
create policy transactions_insert_own
  on public.transactions for insert
  with check (auth.uid() = user_id);

drop policy if exists transactions_admin_select on public.transactions;
create policy transactions_admin_select
  on public.transactions for select
  using (public.is_admin());

drop policy if exists deposit_history_select_own on public.deposit_history;
create policy deposit_history_select_own
  on public.deposit_history for select
  using (auth.uid() = user_id);

drop policy if exists deposit_history_insert_own on public.deposit_history;
create policy deposit_history_insert_own
  on public.deposit_history for insert
  with check (auth.uid() = user_id);

drop policy if exists deposit_history_admin_select on public.deposit_history;
create policy deposit_history_admin_select
  on public.deposit_history for select
  using (public.is_admin());

-- ------------------------------------------------------------
-- 5) RLS'yi tüm uygulama tablolarında zorunlu kıl.
-- ------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.transactions    enable row level security;
alter table public.deposit_history enable row level security;
alter table public.forum_posts     enable row level security;
alter table public.forum_likes     enable row level security;
alter table public.forum_replies   enable row level security;

-- ------------------------------------------------------------
-- 6) Grant sıkılaştırma: anon artık profiles/defter okuyamaz.
--    Forum herkese-açık okuma korunur (tasarım gereği).
-- ------------------------------------------------------------
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

revoke all on public.transactions from anon;
grant select, insert on public.transactions to authenticated;

revoke all on public.deposit_history from anon;
grant select, insert on public.deposit_history to authenticated;

grant select on public.forum_posts to anon, authenticated;
grant insert, delete on public.forum_posts to authenticated;
grant select, insert, delete on public.forum_likes to authenticated;
grant select on public.forum_replies to anon, authenticated;
grant insert, delete on public.forum_replies to authenticated;


-- >>> supabase/migrations/20260915170000_forum_verified_tiers.sql
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
-- (RBAC dosyasında da birebir tanımlı; create or replace ile güvenli.)
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


-- >>> supabase/migrations/20260915180000_forum_moderation_avatars.sql
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


-- >>> supabase/migrations/20260915190000_money_restrictions.sql
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


-- >>> supabase/migrations/20260915200000_mentions.sql
-- ============================================================
-- DenizTradeX — Forum etiketleme (@kullanıcı) bildirimleri
--
-- `notifications`: bahsedilen kullanıcıya düşen "X senden bahsetti"
-- kayıtları. Yazılar:
--   - SADECE `notify_mention` RPC'siyle oluşturulur (SECURITY DEFINER;
--     kullanıcı adı → id çözümlemesi sunucuda yapılır, kendi kendini
--     etiketleme ve bilinmeyen adlar sessizce atlanır),
--   - sahibi tarafından okunur/okundu işaretlenir,
--   - yazı silinirse bildirimi durur (post_id SET NULL, alıntı korunur).
--
-- Doğrudan INSERT politikası bilerek YOKTUR (spam koruması).
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  type           text not null default 'mention' check (type in ('mention')),
  actor_username text not null default '',
  post_id        uuid references public.forum_posts (id) on delete set null,
  reply_id       uuid,
  excerpt        text not null default '',
  is_read        boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where is_read = false;

alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
  on public.notifications for select
  using (auth.uid() = user_id);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own
  on public.notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, update on public.notifications to authenticated;

-- ------------------------------------------------------------
-- notify_mention: gönderi/yanıt yayınlanınca istemci, metindeki her
-- farklı kullanıcı adı için bir kez çağırır. Sunucu:
--  1) arayanı auth.uid()'den bulur (istemciye güvenmez),
--  2) hedefi büyük-küçük harf duyarsız çözer,
--  3) kendi kendini ve bilinmeyen adları atlar,
--  4) alıntıyı 120 karakterde kırparak kaydı yazar.
-- ------------------------------------------------------------
create or replace function public.notify_mention(
  p_username text,
  p_post_id  uuid,
  p_reply_id uuid default null,
  p_excerpt  text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor    text := '';
  v_target   uuid;
begin
  if v_actor_id is null then
    return;
  end if;
  if p_username is null or btrim(p_username) = '' then
    return;
  end if;

  select p.username into v_actor
  from public.profiles as p
  where p.id = v_actor_id;

  select p.id into v_target
  from public.profiles as p
  where lower(p.username) = lower(btrim(p_username))
  limit 1;

  if v_target is null or v_target = v_actor_id then
    return;
  end if;

  insert into public.notifications (user_id, type, actor_username, post_id, reply_id, excerpt)
  values (v_target, 'mention', coalesce(nullif(v_actor, ''), 'biri'), p_post_id, p_reply_id, left(coalesce(p_excerpt, ''), 120));
end;
$$;

revoke all on function public.notify_mention(text, uuid, uuid, text) from public;
grant execute on function public.notify_mention(text, uuid, uuid, text) to authenticated;


-- >>> supabase/migrations/20260915210000_leaderboard.sql
-- ============================================================
-- DenizTradeX — Leaderboard (Trader Skoru sıralaması)
--
-- `get_leaderboard(p_limit)`: herkese açık, salt-okunur RPC.
-- Trader Skoru = min-maks normalize edilmiş 3 bileşenin ağırlıklı
-- ortalaması (0-100):
--   %40 Toplam Portföy  (profiles.balance — hesap varlığı)
--   %30 İşlem Hacmi     (trade_buy + trade_sell toplam USDT)
--   %30 İşlem Performansı (satışlar - alışlar net USDT dengesi)
--
-- Güvenlik:
--  - SECURITY DEFINER tek okuma noktasıdır; e-posta/id sızmaz —
--    yalnızca vitrin kolonları döner (kullanıcı adı, avatar, rozet
--    bilgisi, portföy, hacim, kâr/zarar dengesi, işlem sayısı, skor).
--  - Yasaklı hesaplar (`is_banned`) sıralamaya alınmaz.
--  - Herkese açık akış (anon + authenticated çalıştırabilir), tıpkı
--    forum akışı gibi.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.get_leaderboard(p_limit integer default 50)
returns table (
  username       text,
  avatar_url     text,
  is_admin       boolean,
  has_permissions boolean,
  balance        numeric,
  volume         numeric,
  pnl            numeric,
  trades         bigint,
  score          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with agg as (
    select
      p.username as username,
      p.avatar_url as avatar_url,
      (p.is_admin = true) as is_admin,
      (coalesce(array_length(p.admin_permissions, 1), 0) > 0) as has_permissions,
      coalesce(p.balance, 0) as balance,
      coalesce(sum(
        case when t.type in ('trade_buy', 'trade_sell') then t.amount_usdt else 0 end
      ), 0) as volume,
      coalesce(sum(
        case
          when t.type = 'trade_sell' then t.amount_usdt
          when t.type = 'trade_buy' then -t.amount_usdt
          else 0
        end
      ), 0) as pnl,
      count(case when t.type in ('trade_buy', 'trade_sell') then 1 end) as trades
    from public.profiles as p
    left join public.transactions as t
      on t.user_id = p.id
    where coalesce(p.is_banned, false) = false
    group by p.id, p.username, p.avatar_url, p.is_admin, p.admin_permissions, p.balance
  ),
  mm as (
    select
      min(balance) as mn_b, max(balance) as mx_b,
      min(volume)  as mn_v, max(volume)  as mx_v,
      min(pnl)     as mn_p, max(pnl)     as mx_p
    from agg
  )
  select
    a.username,
    a.avatar_url,
    a.is_admin,
    a.has_permissions,
    a.balance,
    a.volume,
    a.pnl,
    a.trades,
    round(
      (
        0.40 * coalesce((a.balance - mm.mn_b) / nullif(mm.mx_b - mm.mn_b, 0), 1)
        + 0.30 * coalesce((a.volume - mm.mn_v) / nullif(mm.mx_v - mm.mn_v, 0), 1)
        + 0.30 * coalesce((a.pnl - mm.mn_p) / nullif(mm.mx_p - mm.mn_p, 0), 1)
      ) * 100,
      1
    ) as score
  from agg as a
  cross join mm
  order by score desc, volume desc, username asc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function public.get_leaderboard(integer) from public;
grant execute on function public.get_leaderboard(integer) to anon, authenticated;


-- >>> supabase/migrations/20260915220000_subadmin_read.sql
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


-- >>> supabase/migrations/20260915230000_superadmin_protect.sql
-- ============================================================
-- DenizTradeX — Süper admin dokunulmazlığı
--
-- Kural: `is_admin = true` olan bir hesaba (bakiye, dondur, yasakla,
-- para kısıtı, yetki, forum yazısı dahil) HİÇBİR alt yönetici
-- müdahale edemez; yalnızca süper admin dokunabilir. Kendine işlem
-- kuralları aynen korunur.
--
-- Uygulama noktaları:
--  1) Ayrıcalık koruma tetikleyicisi: hedef satır süper adminse ve
--     arayan süper değilse HER türlü güncellemeyi reddeder. RPC
--     (SECURITY DEFINER) içi güncellemelerde de tetikleyici çalışır ve
--     auth.uid() arayanı gösterir — yani tek kural bakiye/dondur/
--     yasakla/para kısıtı/yetki atamalarının TAMAMINI kapsar.
--  2) Forum silme politikaları: süper adminin yazı/yanıtlarını yalnız
--     süper admin silebilir.
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

-- ------------------------------------------------------------
-- Forum: süper adminin yazı/yanıtlarını yalnız süper admin
-- silebilir. Alt yönetici (ban_users dahil) bu satırlara
-- dokunamaz; yetkisiz silme denemesi 0 satır döndürür.
-- ------------------------------------------------------------
drop policy if exists forum_posts_admin_delete on public.forum_posts;
create policy forum_posts_admin_delete
  on public.forum_posts for delete
  using (
    public.is_admin()
    or (
      public.has_admin_permission(auth.uid(), 'ban_users')
      and not exists (
        select 1 from public.profiles as pr
        where pr.id = forum_posts.user_id and pr.is_admin = true
      )
    )
  );

drop policy if exists forum_replies_admin_delete on public.forum_replies;
create policy forum_replies_admin_delete
  on public.forum_replies for delete
  using (
    public.is_admin()
    or (
      public.has_admin_permission(auth.uid(), 'ban_users')
      and not exists (
        select 1 from public.profiles as pr
        where pr.id = forum_replies.user_id and pr.is_admin = true
      )
    )
  );


-- >>> supabase/migrations/20260915240000_profile_realtime.sql
-- ============================================================
-- DenizTradeX — Profil canlı senkronu (bakiye anında yansısın)
--
-- `profiles` tablosu `supabase_realtime` yayınına eklenir: yönetici
-- bakiyeyi değiştirince (veya hesabı dondurup yasaklayınca) kullanıcının
-- açık uygulaması olayı anında alır, çıkış-giriş gerekmez.
--
-- Gizlilik: realtime RLS'ye tabidir; herkes YALNIZCA kendi satırının
-- güncellemelerini alır (`profiles_select_own`).
--
-- Idempotent: tablo zaten yayındaysa atlanır.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end;
$$;
