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
-- `forum_posts`: kullanıcı gönderileri (500 karakter).
-- `forum_likes`: beğeniler; `like_count` tetikleyici ile tutulur.
-- `toggle_forum_like`: atomik beğen/geri-al (tek roundtrip).
-- ============================================================

create table if not exists public.forum_posts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  username   text not null,
  content    text not null check (char_length(content) between 1 and 500),
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
  content    text not null check (char_length(content) between 1 and 500),
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
    -- Bot personaları HER ZAMAN mavi tik (user_id süper admin olsa bile).
    when translate(lower(trim(coalesce(p_username, ''))), 'İI' || chr(775), 'iı')
      in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı') then 'admin'
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
    -- Bot personaları HER ZAMAN mavi tik (user_id süper admin olsa bile).
    when translate(lower(trim(coalesce(p_username, ''))), 'İI' || chr(775), 'iı')
      in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı') then 'admin'
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
  -- Promosyon/referral bonusları kısıttan muaftır; yalnızca kart
  -- yüklemeleri engellenir. (20260916090000_promo_ledger_allow ile uyumlu.)
  if coalesce(NEW.source, 'card') <> 'card' then
    return NEW;
  end if;
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


-- >>> supabase/migrations/20260916090000_promo_ledger_allow.sql
-- ============================================================
-- DenizTradeX — Kısıtlı hesaba promosyon/referral serbestisi
--
-- Para kısıtı (`deposit_blocked`) YALNIZCA kartla yüklemeyi kapsar.
-- `guard_deposit_ledger` backstop'u tüm `deposit_history` satırlarını
-- reddediyordu; promosyon/referral bonusları da deftere düşmüyordu.
-- Bundan böyle bekçi yalnızca `source = 'card'` satırları reddeder;
-- `promo` / `referral` bonusları kısıtlı hesaba da işlenir.
-- Para çekme bekçisi (`withdraw` tipi) aynen korunur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.guard_deposit_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Promosyon/referral bonusları kısıttan muaftır; yalnızca kart
  -- yüklemeleri engellenir.
  if coalesce(NEW.source, 'card') <> 'card' then
    return NEW;
  end if;
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


-- >>> supabase/migrations/20260916110000_announcements.sql
-- ============================================================
-- DenizTradeX — Sistem duyuruları (süper admin yayınları)
--
-- `announcements`: süper adminin tüm kullanıcılara yayınladığı
-- duyurular. Okuma her giriş yapmış kullanıcıya açık; yazma
-- (ekle/sil) YALNIZCA `is_admin = true` süper adminlere aittir
-- (`public.is_admin()` RLS politikasıyla zorlanır).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 120),
  body       text not null check (char_length(body) between 1 and 1000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists announcements_created_at_idx
  on public.announcements (created_at desc);

alter table public.announcements enable row level security;

-- Tüm giriş yapmış kullanıcılar duyuruları okur.
drop policy if exists announcements_select_all on public.announcements;
create policy announcements_select_all
  on public.announcements for select
  to authenticated
  using (true);

-- Yalnızca süper admin yayınlar.
drop policy if exists announcements_admin_insert on public.announcements;
create policy announcements_admin_insert
  on public.announcements for insert
  to authenticated
  with check (public.is_admin());

-- Yalnızca süper admin siler.
drop policy if exists announcements_admin_delete on public.announcements;
create policy announcements_admin_delete
  on public.announcements for delete
  to authenticated
  using (public.is_admin());


-- >>> supabase/migrations/20260916120000_forum_limit_500.sql
-- ============================================================
-- DenizTradeX — Forum karakter sınırı 280 → 500
--
-- Gönderi ve yanıt içerik kontrol kısıtları 500 karaktere
-- genişletilir (istemcideki FORUM_POST_MAX_LENGTH ile aynı).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.forum_posts
  drop constraint if exists forum_posts_content_check;

alter table public.forum_posts
  add constraint forum_posts_content_check
  check (char_length(content) between 1 and 500);

alter table public.forum_replies
  drop constraint if exists forum_replies_content_check;

alter table public.forum_replies
  add constraint forum_replies_content_check
  check (char_length(content) between 1 and 500);


-- >>> supabase/migrations/20260916130000_virtual_market.sql
-- ============================================================
-- DenizTradeX — Sanal Piyasa (AMM x*y=k, iç ekosistem)
--
-- `virtual_coins`: likidite havuzları (rezervler + anlık fiyat).
-- `virtual_holdings`: kullanıcıların sanal coin bakiyeleri (satış
--   tarafı bütünlüğü için şart — havuzdan çıkan token cüzdana işlenir).
-- `execute_virtual_trade`: %0.3 ücretli AMM takası (SECURITY DEFINER).
--   - buy:  p_amount = yatırılan USDT → token çıkar, USDT bakiyesi düşer
--   - sell: p_amount = satılan token → USDT çıkar, USDT bakiyesi artar
--   Başarıda havuz rezervleri, current_price ve volume_24h güncellenir.
--
-- RLS: havuzlar herkese açık okunur; yazım YALNIZCA RPC üzerinden
-- (kullanıcı kendi adına işlem yapar: p_user_id = auth.uid()).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.virtual_coins (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null unique,
  name          text not null,
  type          text not null check (type in ('crypto', 'commodity')),
  reserve_usdt  numeric not null check (reserve_usdt > 0),
  reserve_token numeric not null check (reserve_token > 0),
  current_price numeric not null check (current_price > 0),
  volume_24h    numeric not null default 0
);

create table if not exists public.virtual_holdings (
  user_id  uuid not null references auth.users (id) on delete cascade,
  symbol   text not null references public.virtual_coins (symbol) on delete cascade,
  quantity numeric not null default 0 check (quantity >= 0),
  primary key (user_id, symbol)
);

create index if not exists virtual_holdings_user_idx
  on public.virtual_holdings (user_id);

alter table public.virtual_coins enable row level security;
alter table public.virtual_holdings enable row level security;

-- Havuzlar herkese açık vitrin (giriş yapmış herkes okur).
drop policy if exists virtual_coins_select_all on public.virtual_coins;
create policy virtual_coins_select_all
  on public.virtual_coins for select
  to authenticated
  using (true);

-- Cüzdan satırları yalnızca sahibine görünür.
drop policy if exists virtual_holdings_select_own on public.virtual_holdings;
create policy virtual_holdings_select_own
  on public.virtual_holdings for select
  to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Seed: hiyerarşik havuz derinlikleri (fiyat = usdt/token).
-- ------------------------------------------------------------
insert into public.virtual_coins (symbol, name, type, reserve_usdt, reserve_token, current_price)
values
  ('ENTES', 'ENTES COIN', 'crypto',    50000000,   5000000,  10),
  ('V-XAU', 'Sanal Altın', 'commodity', 30000000,    300000, 100),
  ('V-XAG', 'Sanal Gümüş', 'commodity', 20000000,   1000000,  20),
  ('RGC',   'RGCOIN',      'crypto',     1000000, 100000000,   0.01),
  ('MPRC',  'MPRCOIN',     'crypto',      800000,  26666666,   0.03),
  ('SVGC',  'SVGCOIN',     'crypto',      500000, 100000000,   0.005)
on conflict (symbol) do nothing;

-- ------------------------------------------------------------
-- execute_virtual_trade(p_user_id, p_symbol, p_trade_type, p_amount)
-- returns jsonb { ok, token_amount, usdt_amount, price, new_price,
--                 price_impact_pct }
-- ------------------------------------------------------------
create or replace function public.execute_virtual_trade(
  p_user_id   uuid,
  p_symbol    text,
  p_trade_type text,
  p_amount    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate   constant numeric := 0.003;
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_k          numeric;
  v_in_after   numeric;
  v_token_out  numeric;
  v_usdt_out   numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_old_price  numeric;
  v_balance    numeric;
  v_holding    numeric;
begin
  -- Kimlik: kullanıcı yalnızca kendi adına işlem yapar.
  if auth.uid() is distinct from p_user_id then
    raise exception 'yetkisiz işlem: kendi hesabın için işlem yapabilirsin';
  end if;

  if p_trade_type not in ('buy', 'sell') then
    raise exception 'geçersiz işlem yönü (buy/sell olmalı)';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  select reserve_usdt, reserve_token, current_price
    into v_rusdt, v_rtoken, v_old_price
    from public.virtual_coins
    where symbol = p_symbol
    for update;

  if not found then
    raise exception 'coin bulunamadı';
  end if;

  v_k := v_rusdt * v_rtoken;

  if p_trade_type = 'buy' then
    -- USDT bakiyesi yeterli mi?
    select balance into v_balance from public.profiles where id = p_user_id for update;
    if v_balance is null then
      raise exception 'profil bulunamadı';
    end if;
    if v_balance < p_amount then
      raise exception 'yetersiz USDT bakiyesi';
    end if;

    v_in_after  := p_amount * (1 - v_fee_rate);
    v_new_rusdt := v_rusdt + v_in_after;
    v_token_out := v_rtoken - (v_k / v_new_rusdt);
    if v_token_out <= 0 or v_token_out >= v_rtoken then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken - v_token_out;
    v_usdt_out   := p_amount;

    update public.profiles
      set balance = balance - p_amount
      where id = p_user_id;

    insert into public.virtual_holdings (user_id, symbol, quantity)
      values (p_user_id, p_symbol, v_token_out)
      on conflict (user_id, symbol)
      do update set quantity = public.virtual_holdings.quantity + excluded.quantity;

  else
    -- Token bakiyesi yeterli mi?
    select quantity into v_holding
      from public.virtual_holdings
      where user_id = p_user_id and symbol = p_symbol;
    if coalesce(v_holding, 0) < p_amount then
      raise exception 'yetersiz coin bakiyesi';
    end if;

    v_in_after   := p_amount * (1 - v_fee_rate);
    v_new_rtoken := v_rtoken + v_in_after;
    v_usdt_out   := v_rusdt - (v_k / v_new_rtoken);
    if v_usdt_out <= 0 or v_usdt_out >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rusdt := v_rusdt - v_usdt_out;
    v_token_out := p_amount;

    update public.virtual_holdings
      set quantity = quantity - p_amount
      where user_id = p_user_id and symbol = p_symbol;

    update public.profiles
      set balance = balance + v_usdt_out
      where id = p_user_id;
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_usdt_out
    where symbol = p_symbol;

  return jsonb_build_object(
    'ok', true,
    'token_amount', v_token_out,
    'usdt_amount', v_usdt_out,
    'price', v_old_price,
    'new_price', v_new_price,
    'price_impact_pct', ((v_new_price - v_old_price) / v_old_price) * 100
  );
end;
$$;

revoke all on function public.execute_virtual_trade(uuid, text, text, numeric) from public;
grant execute on function public.execute_virtual_trade(uuid, text, text, numeric) to authenticated;



-- >>> supabase/migrations/20260916140000_virtual_klines.sql
-- ============================================================
-- DenizTradeX — Sanal coin mum verisi (kendi grafik altyapımız)
--
-- `virtual_kline_data`: 1 dakikalık mumlar. Gerçek coinlerde mumlar
-- Binance'den gelir; sanal coinlerde (ENTES, V-XAU, ...) grafik
-- DOĞRUDAN bu tablodan çizilir.
--
-- Yazım: `execute_virtual_trade` her takasta içinde bulunulan dakikanın
-- mumunu upsert eder (open ilk fiyat, high/low uçlar, close son fiyat,
-- volume USDT bacağı toplamı).
--
-- Geçmiş: migration anında her coine 300 adet 1 dakikalık mum tohumlanır
-- (mevcut fiyata biten geriye-yürüyen rastgele yürüyüş), grafik ilk
-- günden canlı görünür.
--
-- Idempotent: tablo/seed tekrar çalıştırılabilir (mumlar çakışırsa atlanır).
-- ============================================================

create table if not exists public.virtual_kline_data (
  id        bigint generated always as identity primary key,
  symbol    text not null references public.virtual_coins (symbol) on delete cascade,
  timestamp timestamptz not null,
  open      numeric not null,
  high      numeric not null,
  low       numeric not null,
  close     numeric not null,
  volume    numeric not null default 0,
  unique (symbol, timestamp)
);

create index if not exists virtual_kline_symbol_time_idx
  on public.virtual_kline_data (symbol, timestamp desc);

alter table public.virtual_kline_data enable row level security;

-- Mumlar herkese açık vitrin (grafik her giriş yapmış kullanıcıya çizilir).
drop policy if exists virtual_kline_select_all on public.virtual_kline_data;
create policy virtual_kline_select_all
  on public.virtual_kline_data for select
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- execute_virtual_trade: mum upsert'i ekle (önceki sürümün üstüne yazar).
-- ------------------------------------------------------------
create or replace function public.execute_virtual_trade(
  p_user_id   uuid,
  p_symbol    text,
  p_trade_type text,
  p_amount    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate   constant numeric := 0.003;
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_k          numeric;
  v_in_after   numeric;
  v_token_out  numeric;
  v_usdt_out   numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_old_price  numeric;
  v_balance    numeric;
  v_holding    numeric;
  v_bucket     timestamptz;
begin
  -- Kimlik: kullanıcı yalnızca kendi adına işlem yapar.
  if auth.uid() is distinct from p_user_id then
    raise exception 'yetkisiz işlem: kendi hesabın için işlem yapabilirsin';
  end if;

  if p_trade_type not in ('buy', 'sell') then
    raise exception 'geçersiz işlem yönü (buy/sell olmalı)';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  select reserve_usdt, reserve_token, current_price
    into v_rusdt, v_rtoken, v_old_price
    from public.virtual_coins
    where symbol = p_symbol
    for update;

  if not found then
    raise exception 'coin bulunamadı';
  end if;

  v_k := v_rusdt * v_rtoken;

  if p_trade_type = 'buy' then
    -- USDT bakiyesi yeterli mi?
    select balance into v_balance from public.profiles where id = p_user_id for update;
    if v_balance is null then
      raise exception 'profil bulunamadı';
    end if;
    if v_balance < p_amount then
      raise exception 'yetersiz USDT bakiyesi';
    end if;

    v_in_after  := p_amount * (1 - v_fee_rate);
    v_new_rusdt := v_rusdt + v_in_after;
    v_token_out := v_rtoken - (v_k / v_new_rusdt);
    if v_token_out <= 0 or v_token_out >= v_rtoken then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken - v_token_out;
    v_usdt_out   := p_amount;

    update public.profiles
      set balance = balance - p_amount
      where id = p_user_id;

    insert into public.virtual_holdings (user_id, symbol, quantity)
      values (p_user_id, p_symbol, v_token_out)
      on conflict (user_id, symbol)
      do update set quantity = public.virtual_holdings.quantity + excluded.quantity;

  else
    -- Token bakiyesi yeterli mi?
    select quantity into v_holding
      from public.virtual_holdings
      where user_id = p_user_id and symbol = p_symbol;
    if coalesce(v_holding, 0) < p_amount then
      raise exception 'yetersiz coin bakiyesi';
    end if;

    v_in_after   := p_amount * (1 - v_fee_rate);
    v_new_rtoken := v_rtoken + v_in_after;
    v_usdt_out   := v_rusdt - (v_k / v_new_rtoken);
    if v_usdt_out <= 0 or v_usdt_out >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rusdt := v_rusdt - v_usdt_out;
    v_token_out := p_amount;

    update public.virtual_holdings
      set quantity = quantity - p_amount
      where user_id = p_user_id and symbol = p_symbol;

    update public.profiles
      set balance = balance + v_usdt_out
      where id = p_user_id;
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_usdt_out
    where symbol = p_symbol;

  -- 1 dakikalık mum upsert: open ilk fiyat, close son fiyat.
  v_bucket := date_trunc('minute', now());
  insert into public.virtual_kline_data
    (symbol, timestamp, open, high, low, close, volume)
  values
    (p_symbol, v_bucket, v_old_price,
     greatest(v_old_price, v_new_price),
     least(v_old_price, v_new_price),
     v_new_price, v_usdt_out)
  on conflict (symbol, timestamp)
  do update set
    high   = greatest(public.virtual_kline_data.high, excluded.high),
    low    = least(public.virtual_kline_data.low, excluded.low),
    close  = excluded.close,
    volume = public.virtual_kline_data.volume + excluded.volume;

  return jsonb_build_object(
    'ok', true,
    'token_amount', v_token_out,
    'usdt_amount', v_usdt_out,
    'price', v_old_price,
    'new_price', v_new_price,
    'price_impact_pct', ((v_new_price - v_old_price) / v_old_price) * 100
  );
end;
$$;

revoke all on function public.execute_virtual_trade(uuid, text, text, numeric) from public;
grant execute on function public.execute_virtual_trade(uuid, text, text, numeric) to authenticated;

-- ------------------------------------------------------------
-- Geçmiş tohumlama: her coine 300 adet 1 dakikalık mum (mevcut
-- fiyata biten geriye-yürüyen yürüyüş; volatilite havu sığlığına göre).
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_vol numeric;
  v_closes numeric[];
  v_ts timestamptz;
  v_o numeric;
  v_h numeric;
  v_l numeric;
  v_c numeric;
  v_v numeric;
  j integer;
  i integer;
begin
  for r in
    select symbol, current_price, reserve_usdt from public.virtual_coins
  loop
    -- Derin havuz (ENTES/V-XAU/V-XAG): sakin; sığ havuz: hareketli.
    v_vol := case r.symbol
      when 'ENTES' then 0.0006
      when 'V-XAU' then 0.0004
      when 'V-XAG' then 0.0008
      when 'RGC'   then 0.004
      when 'MPRC'  then 0.006
      else 0.010
    end;

    -- Kapanış zinciri güncelden eskiye kurulur: v_closes[1] güncel mum
    -- (güncel fiyat), v_closes[300] en eski mum. Dizi 1-tabanlıdır.
    v_closes := array[r.current_price];
    for j in 1..299 loop
      v_closes := v_closes || (v_closes[j] / (1 + (random() - 0.5) * v_vol * 2));
    end loop;

    for i in reverse 0..299 loop
      v_ts := date_trunc('minute', now()) - (i || ' minutes')::interval;
      v_c := v_closes[i + 1];
      v_o := v_c * (1 + (random() - 0.5) * v_vol);
      v_h := greatest(v_o, v_c) * (1 + random() * v_vol * 0.5);
      v_l := least(v_o, v_c) * (1 - random() * v_vol * 0.5);
      v_v := r.reserve_usdt * v_vol * (0.5 + random());
      insert into public.virtual_kline_data
        (symbol, timestamp, open, high, low, close, volume)
      values (r.symbol, v_ts, v_o, v_h, v_l, v_c, v_v)
      on conflict (symbol, timestamp) do nothing;
    end loop;
  end loop;
end;
$$;



-- >>> supabase/migrations/20260916150000_bot_simulation.sql
-- ============================================================
-- DenizTradeX — Bot Simülasyon Motoru (piyasa manipülasyon testleri)
--
-- KULLANIM: YALNIZCA süper admin (Admin → Bot Test Paneli). Botlar
-- forumda mesaj paylaşıp sanal havuzlarda balina hamlesi yapar; grafik
-- ve piyasa listesi gerçek işlemdeki gibi güncellenir.
--
-- `post_bot_message(p_username, p_content, p_fake_likes)`:
--   Bot personası adına forum gönderisi (sahte beğeni sayısıyla).
--   Bot mesajları default insan silüeti (avatar_url NULL → UI silüeti)
--   + mavi tik (admin rozeti) ile yayınlanır.
-- `execute_bot_trade(p_symbol, p_trade_type, p_usdt_amount)`:
--   USDT cinsinden balina hamlesi — kullanıcı bakiyesine DOKUNMAZ,
--   yalnızca havuzu oynatır (rezerv + fiyat + hacim + 1m mumu).
--   - buy:  p_usdt_amount havuza girer, token çıkar.
--   - sell: p_usdt_amount havuzdan çıkar (gerekli token otomatik hesaplanır).
--
-- Her iki fonksiyon da `is_admin()` zorlar (süper admin dışı reddedilir).
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- Bot forum mesajı
-- ------------------------------------------------------------
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

insert into public.forum_posts (user_id, username, content, like_count)
  values (v_uid, trim(p_username), trim(p_content), greatest(coalesce(p_fake_likes, 0), 0))
  returning id into v_id;

  -- Bot mesajları: default insan silüeti (avatar NULL) + mavi tik.
  -- Yazar tetikleyicisi adminin kendi avatarını basmış olabilir; botlar
  -- için bilerek NULL'a çekilir (UI default silüeti çizer).
  update public.forum_posts
    set verified_tier = 'admin',
        is_verified = true,
        avatar_url = null
    where id = v_id;

  return v_id;
end;
$$;

revoke all on function public.post_bot_message(text, text, integer) from public;
grant execute on function public.post_bot_message(text, text, integer) to authenticated;

-- ------------------------------------------------------------
-- Bot havuz hamlesi (USDT cinsinden, bakiyesiz sistem likiditesi)
-- ------------------------------------------------------------
create or replace function public.execute_bot_trade(
  p_symbol      text,
  p_trade_type  text,
  p_usdt_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate   constant numeric := 0.003;
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_k          numeric;
  v_token_in   numeric;
  v_token_out  numeric;
  v_usdt_out   numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_old_price  numeric;
  v_volume     numeric;
  v_bucket     timestamptz;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin bot çalıştırabilir';
  end if;

  if p_trade_type not in ('buy', 'sell') then
    raise exception 'geçersiz işlem yönü (buy/sell olmalı)';
  end if;

  if p_usdt_amount is null or p_usdt_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  select reserve_usdt, reserve_token, current_price
    into v_rusdt, v_rtoken, v_old_price
    from public.virtual_coins
    where symbol = p_symbol
    for update;

  if not found then
    raise exception 'coin bulunamadı';
  end if;

  v_k := v_rusdt * v_rtoken;

  if p_trade_type = 'buy' then
    v_token_out  := v_rtoken - (v_k / (v_rusdt + p_usdt_amount * (1 - v_fee_rate)));
    if v_token_out <= 0 or v_token_out >= v_rtoken then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rusdt := v_rusdt + p_usdt_amount * (1 - v_fee_rate);
    v_new_rtoken := v_rtoken - v_token_out;
    v_usdt_out  := p_usdt_amount;
    v_volume    := p_usdt_amount;
  else
    -- Hedef USDT çıkışına ulaşan token girişi (ücret dahil) tersine çözülür.
    if p_usdt_amount >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_token_in  := ((v_k / (v_rusdt - p_usdt_amount)) - v_rtoken) / (1 - v_fee_rate);
    if v_token_in <= 0 then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken + v_token_in * (1 - v_fee_rate);
    v_new_rusdt := v_rusdt - p_usdt_amount;
    v_token_out := v_token_in;
    v_usdt_out  := p_usdt_amount;
    v_volume    := p_usdt_amount;
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_volume
    where symbol = p_symbol;

  -- 1 dakikalık mum upsert (gerçek takasla aynı kural).
  v_bucket := date_trunc('minute', now());
  insert into public.virtual_kline_data
    (symbol, timestamp, open, high, low, close, volume)
  values
    (p_symbol, v_bucket, v_old_price,
     greatest(v_old_price, v_new_price),
     least(v_old_price, v_new_price),
     v_new_price, v_volume)
  on conflict (symbol, timestamp)
  do update set
    high   = greatest(public.virtual_kline_data.high, excluded.high),
    low    = least(public.virtual_kline_data.low, excluded.low),
    close  = excluded.close,
    volume = public.virtual_kline_data.volume + excluded.volume;

  return jsonb_build_object(
    'ok', true,
    'token_amount', v_token_out,
    'usdt_amount', v_usdt_out,
    'price', v_old_price,
    'new_price', v_new_price,
    'price_impact_pct', ((v_new_price - v_old_price) / v_old_price) * 100
  );
end;
$$;

revoke all on function public.execute_bot_trade(text, text, numeric) from public;
grant execute on function public.execute_bot_trade(text, text, numeric) to authenticated;


-- >>> supabase/migrations/20260916160000_altcoin_admin.sql
-- ============================================================
-- DenizTradeX — Altcoin Yönetimi (Admin Paneli)
--
-- virtual_coins tablosuna durum alanı (promote/demote) eklenir.
-- coin_news tablosu: coin bazlı haber/duyuru yönetimi.
-- Tüm yazımlar admin_update_coin RPC'si üzerinden (süper admin).
-- ============================================================

-- ------------------------------------------------------------
-- 1) virtual_coins: durum kolonu (promote/demote)
-- ------------------------------------------------------------
alter table public.virtual_coins
  add column if not exists status text not null default 'normal'
  check (status in ('normal', 'promoted', 'demoted'));

-- Mevcut coinler 'normal' olarak kalır (idempotent).

-- ------------------------------------------------------------
-- 2) coin_news: coin bazlı haberler
-- ------------------------------------------------------------
create table if not exists public.coin_news (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null references public.virtual_coins (symbol) on delete cascade,
  title         text not null,
  body          text not null,
  created_by    uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists coin_news_symbol_idx
  on public.coin_news (symbol);

create index if not exists coin_news_created_at_idx
  on public.coin_news (created_at desc);

alter table public.coin_news enable row level security;

-- Herkes okuyabilir (giriş yapmış kullanıcılar).
drop policy if exists coin_news_select_all on public.coin_news;
create policy coin_news_select_all
  on public.coin_news for select
  to authenticated
  using (true);

-- Yazım yalnızca süper admin (is_admin()).
drop policy if exists coin_news_insert_admin on public.coin_news;
create policy coin_news_insert_admin
  on public.coin_news for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists coin_news_update_admin on public.coin_news;
create policy coin_news_update_admin
  on public.coin_news for update
  to authenticated
  with check (public.is_admin());

drop policy if exists coin_news_delete_admin on public.coin_news;
create policy coin_news_delete_admin
  on public.coin_news for delete
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- 3) updated_at tetikleyicisi (coin_news)
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;

drop trigger if exists coin_news_updated_at on public.coin_news;
create trigger coin_news_updated_at
  before update on public.coin_news
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 4) admin_update_coin: coin durumu ve haber yönetimi (süper admin)
-- ------------------------------------------------------------
create or replace function public.admin_update_coin(
  p_symbol     text,
  p_status     text default null,
  p_news_title text default null,
  p_news_body  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin coin yönetebilir';
  end if;

  if coalesce(trim(p_symbol), '') = '' then
    raise exception 'geçersiz coin sembolü';
  end if;

  -- Coin var mı?
  select true into v_exists
    from public.virtual_coins
    where symbol = p_symbol;
  if not found then
    raise exception 'coin bulunamadı: %', p_symbol;
  end if;

  -- Durum güncelleme
  if p_status is not null then
    if p_status not in ('normal', 'promoted', 'demoted') then
      raise exception 'geçersiz durum: normal, promoted, demoted olmalı';
    end if;
    update public.virtual_coins
      set status = p_status
      where symbol = p_symbol;
  end if;

  -- Haber ekleme
  if p_news_title is not null and p_news_body is not null then
    if char_length(trim(p_news_title)) > 200 then
      raise exception 'haber başlığı en fazla 200 karakter olabilir';
    end if;
    if char_length(trim(p_news_body)) > 2000 then
      raise exception 'haber metni en fazla 2000 karakter olabilir';
    end if;
    insert into public.coin_news (symbol, title, body, created_by)
    values (p_symbol, trim(p_news_title), trim(p_news_body), auth.uid());
  end if;

  -- Güncel coin + haberleri döndür
  return jsonb_build_object(
    'ok', true,
    'symbol', p_symbol,
    'status', (select status from public.virtual_coins where symbol = p_symbol),
    'news', (
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'title', title,
        'body', body,
        'created_at', created_at
      ) order by created_at desc)
      from public.coin_news
      where symbol = p_symbol
      limit 20
    )
  );
end;
$$;

revoke all on function public.admin_update_coin(text, text, text, text) from public;
grant execute on function public.admin_update_coin(text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 5) admin_delete_coin_news: haber silme (süper admin)
-- ------------------------------------------------------------
create or replace function public.admin_delete_coin_news(
  p_news_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin haber silebilir';
  end if;

  delete from public.coin_news
    where id = p_news_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_delete_coin_news(uuid) from public;
grant execute on function public.admin_delete_coin_news(uuid) to authenticated;

-- >>> supabase/migrations/20260916170000_coin_overrides.sql
-- ============================================================
-- DenizTradeX — Tüm Coinler için Yükseltme/Düşürme + Haber
--
-- Önceki tasarım yalnızca `virtual_coins` tablosundaki 6 sanal coini
-- kapsıyordu (FK kısıtı yüzünden BTCUSDT gibi gerçek sembollere haber
-- eklenemiyor, durum değiştirilemiyordu).
--
-- Bu migration ile yönetim TÜM sembollere genellenir:
-- 1) `coin_overrides`: HERHANGİ bir sembol için durum
--    (normal/promoted/demoted). Sanal coin + Binance sembolleri dahil.
-- 2) `coin_news.symbol` FK'si kaldırılır (düz metin) — herhangi bir
--    sembole haber eklenebilir. Mevcut haberler korunur.
-- 3) `admin_update_coin` güncellenir: sanal coinde hem havuz satırı hem
--    override yazılır; sanal olmayan sembolde yalnızca override + haber.
-- 4) Mevcut sanal durumlar override tablosuna taşınır (idempotent).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) coin_overrides: her sembol için durum
-- ------------------------------------------------------------
create table if not exists public.coin_overrides (
  symbol     text primary key,
  status     text not null default 'normal'
    check (status in ('normal', 'promoted', 'demoted')),
  updated_at timestamptz not null default now()
);

alter table public.coin_overrides enable row level security;

-- Durumlar herkese açık vitrin (giriş yapmış herkes okur).
drop policy if exists coin_overrides_select_all on public.coin_overrides;
create policy coin_overrides_select_all
  on public.coin_overrides for select
  to authenticated
  using (true);

-- Yazım yalnızca süper admin.
drop policy if exists coin_overrides_write_admin on public.coin_overrides;
create policy coin_overrides_write_admin
  on public.coin_overrides for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- set_updated_at altcoin_admin migration'ında tanımlıdır; tek başına
-- uygulanırsa diye burada da güvenceye alınır (aynı tanım, idempotent).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;

drop trigger if exists coin_overrides_updated_at on public.coin_overrides;
create trigger coin_overrides_updated_at
  before update on public.coin_overrides
  for each row execute function public.set_updated_at();

-- Mevcut sanal durumları taşı (normal dışı olanlar; normal zaten varsayılan).
insert into public.coin_overrides (symbol, status)
select symbol, status
  from public.virtual_coins
  where status is distinct from 'normal'
on conflict (symbol)
do update set
  status = excluded.status,
  updated_at = now();

-- ------------------------------------------------------------
-- 2) coin_news.symbol: FK'yi kaldır, düz metin yap
-- ------------------------------------------------------------
do $$
declare
  v_con text;
begin
  if to_regclass('public.coin_news') is null then
    return;
  end if;
  select conname into v_con
    from pg_constraint
    where conrelid = 'public.coin_news'::regclass
      and contype = 'f'
  limit 1;
  if v_con is not null then
    execute format('alter table public.coin_news drop constraint %I', v_con);
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 3) admin_update_coin: TÜM semboller
-- ------------------------------------------------------------
create or replace function public.admin_update_coin(
  p_symbol     text,
  p_status     text default null,
  p_news_title text default null,
  p_news_body  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol text := upper(trim(coalesce(p_symbol, '')));
  v_status text;
  v_is_virtual boolean;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin coin yönetebilir';
  end if;

  if v_symbol = '' then
    raise exception 'geçersiz coin sembolü';
  end if;

  select true into v_is_virtual
    from public.virtual_coins
    where symbol = v_symbol;
  v_is_virtual := coalesce(v_is_virtual, false);

  -- Durum güncelleme (tüm semboller override tablosuna yazılır).
  if p_status is not null then
    if p_status not in ('normal', 'promoted', 'demoted') then
      raise exception 'geçersiz durum: normal, promoted, demoted olmalı';
    end if;
    insert into public.coin_overrides (symbol, status)
    values (v_symbol, p_status)
    on conflict (symbol)
    do update set
      status = excluded.status,
      updated_at = now();
    -- Sanal coinde havuz satırı da senkron tutulur (eski okuyucular için).
    if v_is_virtual then
      update public.virtual_coins
        set status = p_status
        where symbol = v_symbol;
    end if;
  end if;

  -- Haber ekleme (tüm semboller).
  if p_news_title is not null and p_news_body is not null then
    if char_length(trim(p_news_title)) = 0 or char_length(trim(p_news_body)) = 0 then
      raise exception 'haber başlığı ve metni gerekli';
    end if;
    if char_length(trim(p_news_title)) > 200 then
      raise exception 'haber başlığı en fazla 200 karakter olabilir';
    end if;
    if char_length(trim(p_news_body)) > 2000 then
      raise exception 'haber metni en fazla 2000 karakter olabilir';
    end if;
    insert into public.coin_news (symbol, title, body, created_by)
    values (v_symbol, trim(p_news_title), trim(p_news_body), auth.uid());
  end if;

  select coalesce(
    (select status from public.coin_overrides where symbol = v_symbol),
    (select status from public.virtual_coins where symbol = v_symbol),
    'normal'
  ) into v_status;

  return jsonb_build_object(
    'ok', true,
    'symbol', v_symbol,
    'status', v_status,
    'news', (
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'title', title,
        'body', body,
        'created_at', created_at
      ) order by created_at desc)
      from public.coin_news
      where symbol = v_symbol
      limit 20
    )
  );
end;
$$;

revoke all on function public.admin_update_coin(text, text, text, text) from public;
grant execute on function public.admin_update_coin(text, text, text, text) to authenticated;


-- >>> supabase/migrations/20260916180000_trading_state.sql
-- ============================================================
-- DenizTradeX — Cihazlar Arası İşlem Senkronu
--
-- Sorun: açık pozisyonlar / spot bakiyeler / bekleyen emirler yalnızca
-- cihazın localStorage'ında (mobilde açılan işlem masaüstünde görünmez).
-- Bakiye zaten `profiles.balance` üzerinden senkrondu; bu tablo geri
-- kalan işlem durumunu sunucuya taşır.
--
-- `trading_state`: kullanıcı başına tek satır (user_id PK).
--   - positions / spot_balances / spot_positions / pending_orders /
--     trades / spot_trades: JSONB anlık görüntüler.
--   - updated_at: son yazan cihazın zamanı (çatışmada son yazan kazanır).
--
-- RLS: satır yalnızca sahibine görünür/yazılır.
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.trading_state (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  positions      jsonb not null default '[]'::jsonb,
  spot_balances  jsonb not null default '{}'::jsonb,
  spot_positions jsonb not null default '[]'::jsonb,
  pending_orders jsonb not null default '[]'::jsonb,
  trades         jsonb not null default '[]'::jsonb,
  spot_trades    jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

alter table public.trading_state enable row level security;

drop policy if exists trading_state_select_own on public.trading_state;
create policy trading_state_select_own
  on public.trading_state for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists trading_state_insert_own on public.trading_state;
create policy trading_state_insert_own
  on public.trading_state for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists trading_state_update_own on public.trading_state;
create policy trading_state_update_own
  on public.trading_state for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists trading_state_delete_own on public.trading_state;
create policy trading_state_delete_own
  on public.trading_state for delete
  to authenticated
  using (auth.uid() = user_id);


-- >>> supabase/migrations/20260916190000_risk_config.sql
-- ============================================================
-- DenizTradeX — Risk Yapılandırması (adil likidasyon)
--
-- Sorun: likidasyon eşikleri koda gömülüydü; bakım marjini kavramı yoktu
-- ve ham tik fiyatı tek bir fitilde pozisyon patlatıyordu.
--
-- Bu migration risk parametrelerini veritabanına taşır (Binance Futures
-- mantığı: düşük bakım marjini + mark-price + kademeli uyarı):
--   - `risk_config`: tek satırlık (id=1) yapılandırma tablosu.
--   - `maintenance_margin_rate`: likidasyon fiyatındaki bakım payı
--     (varsayılan %0.4 — Binance en düşük kademesi).
--   - `margin_call_warn_loss_frac` / `margin_call_critical_loss_frac`:
--     teminatın uyarı (%50) ve kritik (%80) tüketim eşikleri.
--   - `liq_confirm_ticks`: likidasyonun kaç ardışık fiyat kontrolü
--     ihlalden sonra işletileceği (tek fitil patlatmaz).
--   - `mark_price_window`: mark-price medyan pencere genişliği.
--   - `bot_max_pool_fraction`: bot hamlesinin havuz rezervine oranı
--     üst sınırı (sığ havuzda devasa kayma engeli).
-- Yazım `update_risk_config` RPC'sinden geçer (yalnızca süper admin);
-- okuma tüm giriş yapmış kullanıcılara açıktır.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.risk_config (
  id                            integer primary key default 1 check (id = 1),
  maintenance_margin_rate       numeric not null default 0.004
    check (maintenance_margin_rate >= 0 and maintenance_margin_rate <= 0.1),
  margin_call_warn_loss_frac    numeric not null default 0.5
    check (margin_call_warn_loss_frac > 0 and margin_call_warn_loss_frac < 1),
  margin_call_critical_loss_frac numeric not null default 0.8
    check (margin_call_critical_loss_frac > 0 and margin_call_critical_loss_frac < 1),
  liq_confirm_ticks             integer not null default 3
    check (liq_confirm_ticks >= 1 and liq_confirm_ticks <= 20),
  mark_price_window             integer not null default 5
    check (mark_price_window >= 1 and mark_price_window <= 50),
  bot_max_pool_fraction         numeric not null default 0.02
    check (bot_max_pool_fraction > 0 and bot_max_pool_fraction <= 0.2),
  updated_at                    timestamptz not null default now()
);

alter table public.risk_config enable row level security;

-- Parametreler herkese açık vitrin (giriş yapmış herkes okur).
drop policy if exists risk_config_select_all on public.risk_config;
create policy risk_config_select_all
  on public.risk_config for select
  to authenticated
  using (true);

-- Doğrudan yazım kapalı; yalnız RPC (aşağıda) yazar.
drop policy if exists risk_config_no_direct_write on public.risk_config;
create policy risk_config_no_direct_write
  on public.risk_config for all
  to authenticated
  using (false)
  with check (false);

-- Varsayılan satırı tohumla (idempotent).
insert into public.risk_config (id)
values (1)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- update_risk_config: risk parametrelerini günceller (süper admin)
-- ------------------------------------------------------------
create or replace function public.update_risk_config(
  p_maintenance_margin_rate        numeric default null,
  p_margin_call_warn_loss_frac     numeric default null,
  p_margin_call_critical_loss_frac numeric default null,
  p_liq_confirm_ticks              integer default null,
  p_mark_price_window              integer default null,
  p_bot_max_pool_fraction          numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin risk ayarını değiştirebilir';
  end if;

  if p_margin_call_warn_loss_frac is not null
     and p_margin_call_critical_loss_frac is not null
     and p_margin_call_warn_loss_frac >= p_margin_call_critical_loss_frac then
    raise exception 'uyarı eşiği kritik eşikten küçük olmalı';
  end if;

  update public.risk_config
    set maintenance_margin_rate        = coalesce(p_maintenance_margin_rate, maintenance_margin_rate),
        margin_call_warn_loss_frac     = coalesce(p_margin_call_warn_loss_frac, margin_call_warn_loss_frac),
        margin_call_critical_loss_frac = coalesce(p_margin_call_critical_loss_frac, margin_call_critical_loss_frac),
        liq_confirm_ticks              = coalesce(p_liq_confirm_ticks, liq_confirm_ticks),
        mark_price_window              = coalesce(p_mark_price_window, mark_price_window),
        bot_max_pool_fraction          = coalesce(p_bot_max_pool_fraction, bot_max_pool_fraction),
        updated_at                     = now()
    where id = 1;

  return jsonb_build_object(
    'ok', true,
    'config', (
      select to_jsonb(public.risk_config)
        from public.risk_config
        where id = 1
    )
  );
end;
$$;

revoke all on function public.update_risk_config(numeric, numeric, numeric, integer, integer, numeric) from public;
grant execute on function public.update_risk_config(numeric, numeric, numeric, integer, integer, numeric) to authenticated;


-- >>> supabase/migrations/20260916210000_bot_badge_fix.sql
-- ============================================================
-- DenizTradeX — Bot rozet düzeltmesi (mavi tik)
--
-- Sorun: bot personaları forumda süper adminin `user_id`'siyle
-- postalandığı için `forum_verified_tier()` onlara 'super' (SARI tik)
-- basıyordu — insert tetikleyicisi, `admin_update_profile` rozet
-- tazeleme adımı ve geriye-dönük işaretlemelerin TAMAMI bu fonksiyondan
-- geçtiği için botlar idari bir işlem sonrası sarıya dönüyordu.
--
-- Çözüm: tek doğruluk kaynağı olan `forum_verified_tier()` içine bot
-- kontrolü (kullanıcı adından, user_id'den DEĞİL) eklenir + mevcut sarı
-- tikli bot yazıları maviye çekilir. Idempotent.
--
-- Locale notu: `lower('İ')` çoğu UTF-8 locale'de 'i'+birleşen nokta
-- (U+0307) üretir, C locale'de 'İ' kalır. `translate` eşlemesi
-- ('İ'→'i', 'I'→'ı', U+0307 silinir) eşleşmeyi locale'den bağımsız kılar.
-- ============================================================

create or replace function public.forum_verified_tier(p_user_id uuid, p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- Bot personaları HER ZAMAN mavi tik (user_id süper admin olsa bile).
    when translate(lower(trim(coalesce(p_username, ''))), 'İI' || chr(775), 'iı')
      in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı') then 'admin'
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

-- Mevcut sarı tikli bot yazılarını maviye çek (geriye dönük onarım).
update public.forum_posts as p
set verified_tier = 'admin',
    is_verified = true
where p.verified_tier <> 'admin'
  and translate(lower(trim(coalesce(p.username, ''))), 'İI' || chr(775), 'iı')
    in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı');

update public.forum_replies as r
set verified_tier = 'admin',
    is_verified = true
where r.verified_tier <> 'admin'
  and translate(lower(trim(coalesce(r.username, ''))), 'İI' || chr(775), 'iı')
    in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı');


-- >>> supabase/migrations/20260916220000_events.sql
-- ============================================================
-- DenizTradeX — Etkinlikler (Events)
--
-- `events`: admin tarafından girilen platform etkinlikleri/duyuruları
-- (yarışma, ödüllü işlem haftası vb.). Menüdeki "Etkinlik" sekmesinde
-- listelenir; kayıt yoksa istemci "aktif etkinlik yok" gösterir.
-- Yazım YALNIZCA süper admin (RPC + RLS çift kapı).
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 120),
  body        text not null check (char_length(body) between 1 and 2000),
  starts_at   timestamptz,
  ends_at     timestamptz,
  is_active   boolean not null default true,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists events_active_idx
  on public.events (is_active, created_at desc);

alter table public.events enable row level security;

-- Herkes okur (giriş yapmış kullanıcılar).
drop policy if exists events_select_all on public.events;
create policy events_select_all
  on public.events for select
  to authenticated
  using (true);

-- Doğrudan yazım kapalı; yalnız RPC yazar.
drop policy if exists events_no_direct_write on public.events;
create policy events_no_direct_write
  on public.events for all
  to authenticated
  using (false)
  with check (false);

drop trigger if exists events_updated_at on public.events;
create trigger events_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- upsert_event: etkinlik ekle/güncelle (süper admin)
-- ------------------------------------------------------------
create or replace function public.upsert_event(
  p_id        uuid default null,
  p_title     text default null,
  p_body      text default null,
  p_starts_at timestamptz default null,
  p_ends_at   timestamptz default null,
  p_is_active boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin etkinlik düzenleyebilir';
  end if;

  if p_id is null then
    if coalesce(trim(p_title), '') = '' then
      raise exception 'etkinlik başlığı gerekli';
    end if;
    if coalesce(trim(p_body), '') = '' then
      raise exception 'etkinlik metni gerekli';
    end if;
    if char_length(trim(p_title)) > 120 then
      raise exception 'başlık en fazla 120 karakter olabilir';
    end if;
    if char_length(trim(p_body)) > 2000 then
      raise exception 'metin en fazla 2000 karakter olabilir';
    end if;
    if p_ends_at is not null and p_starts_at is not null and p_ends_at <= p_starts_at then
      raise exception 'bitiş tarihi başlangıçtan sonra olmalı';
    end if;
    insert into public.events (title, body, starts_at, ends_at, is_active, created_by)
    values (
      trim(p_title), trim(p_body), p_starts_at, p_ends_at,
      coalesce(p_is_active, true), auth.uid()
    )
    returning id into v_id;
  else
    update public.events
      set title     = coalesce(trim(p_title), title),
          body      = coalesce(trim(p_body), body),
          starts_at = coalesce(p_starts_at, starts_at),
          ends_at   = coalesce(p_ends_at, ends_at),
          is_active = coalesce(p_is_active, is_active)
      where id = p_id
      returning id into v_id;
    if not found then
      raise exception 'etkinlik bulunamadı';
    end if;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.upsert_event(uuid, text, text, timestamptz, timestamptz, boolean) from public;
grant execute on function public.upsert_event(uuid, text, text, timestamptz, timestamptz, boolean) to authenticated;

-- ------------------------------------------------------------
-- delete_event: etkinlik sil (süper admin)
-- ------------------------------------------------------------
create or replace function public.delete_event(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin etkinlik silebilir';
  end if;
  delete from public.events where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_event(uuid) from public;
grant execute on function public.delete_event(uuid) to authenticated;


-- >>> supabase/migrations/20260918090000_admin_delete_user.sql
-- ============================================================
-- DenizTradeX — Admin kullanıcı silme (komple + isim serbest)
--
-- `admin_delete_user(p_user_id)`: SECURITY DEFINER RPC.
--  - Yetki: arayan süper admin (`is_admin`) veya `admin_permissions`
--    içinde `delete_users` izni olan alt yönetici.
--  - Koruma: kendi hesabını silemez; başka bir süper admini kimse
--    silemez (kilitlenme koruması).
--  - Silme: `auth.users` satırı silinir → profiles, transactions,
--    deposit_history, forum_posts/replies/likes, virtual_holdings,
--    trading_state, notifications satırları `on delete cascade` ile
--    komple gider. Kullanıcı adı unique kısıttan düşer; başkası aynı
--    isimle sıfırdan kayıt olabilir.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.admin_delete_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_caller_is_admin boolean;
  v_caller_perms jsonb;
  v_target_username text;
  v_target_is_admin boolean;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'giriş gerekli';
  end if;
  if p_user_id is null then
    raise exception 'geçersiz kullanıcı';
  end if;
  if v_caller = p_user_id then
    raise exception 'kendi hesabını silemezsin';
  end if;

  select is_admin, to_jsonb(coalesce(admin_permissions, '{}'))
    into v_caller_is_admin, v_caller_perms
    from public.profiles
    where id = v_caller;
  if v_caller_is_admin is null then
    raise exception 'yetkisiz işlem: yönetici değilsin';
  end if;
  if v_caller_is_admin is not true
     and not (v_caller_perms ? 'delete_users') then
    raise exception 'yetkisiz işlem: kullanıcı silme yetkin yok';
  end if;

  select username, is_admin
    into v_target_username, v_target_is_admin
    from public.profiles
    where id = p_user_id;
  if not found then
    raise exception 'kullanıcı bulunamadı';
  end if;
  if v_target_is_admin is true then
    raise exception 'süper admin hesabı silinemez';
  end if;

  -- Forum + cüzdan + işlem + durum satırları cascade ile gider.
  delete from auth.users where id = p_user_id;

  return jsonb_build_object('ok', true, 'username', v_target_username);
end;
$$;

revoke all on function public.admin_delete_user(uuid) from public;
grant execute on function public.admin_delete_user(uuid) to authenticated;


-- >>> supabase/migrations/20260918100000_forum_images_tags.sql
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


-- >>> supabase/migrations/20260918110000_forum_reply_likes.sql
-- ============================================================
-- DenizTradeX — Yanıt beğenme (reply likes)
--
-- `forum_reply_likes`: (reply_id, user_id) beğenileri;
-- `forum_replies.like_count` tetikleyici ile tutulur.
-- `toggle_forum_reply_like`: atomik beğen/geri-al (tek roundtrip).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.forum_replies
  add column if not exists like_count integer not null default 0;

create table if not exists public.forum_reply_likes (
  reply_id   uuid not null references public.forum_replies (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reply_id, user_id)
);

create index if not exists forum_reply_likes_user_id_idx
  on public.forum_reply_likes (user_id);

alter table public.forum_reply_likes enable row level security;

drop policy if exists forum_reply_likes_select_all on public.forum_reply_likes;
create policy forum_reply_likes_select_all
  on public.forum_reply_likes for select
  using (true);

drop policy if exists forum_reply_likes_insert_own on public.forum_reply_likes;
create policy forum_reply_likes_insert_own
  on public.forum_reply_likes for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_reply_likes_delete_own on public.forum_reply_likes;
create policy forum_reply_likes_delete_own
  on public.forum_reply_likes for delete
  using (auth.uid() = user_id);

grant select, insert, delete on public.forum_reply_likes to authenticated;
alter table public.forum_reply_likes enable row level security;

-- ------------------------------------------------------------
-- like_count bakım tetikleyicisi
-- ------------------------------------------------------------
create or replace function public.sync_forum_reply_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.forum_replies
    set like_count = (select count(*) from public.forum_reply_likes where reply_id = OLD.reply_id)
    where id = OLD.reply_id;
    return OLD;
  end if;
  update public.forum_replies
  set like_count = (select count(*) from public.forum_reply_likes where reply_id = NEW.reply_id)
  where id = NEW.reply_id;
  return NEW;
end;
$$;

drop trigger if exists forum_reply_likes_count_trigger on public.forum_reply_likes;
create trigger forum_reply_likes_count_trigger
  after insert or delete on public.forum_reply_likes
  for each row execute function public.sync_forum_reply_like_count();

-- ------------------------------------------------------------
-- Atomik beğen/geri-al. Dönen JSON: {"liked": true|false, "like_count": n}
-- ------------------------------------------------------------
create or replace function public.toggle_forum_reply_like(p_reply_id uuid)
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

  perform 1 from public.forum_replies where id = p_reply_id for update;
  if not found then
    return jsonb_build_object('liked', false, 'like_count', 0);
  end if;

  if exists (
    select 1 from public.forum_reply_likes where reply_id = p_reply_id and user_id = v_uid
  ) then
    delete from public.forum_reply_likes where reply_id = p_reply_id and user_id = v_uid;
    v_liked := false;
  else
    insert into public.forum_reply_likes (reply_id, user_id) values (p_reply_id, v_uid);
    v_liked := true;
  end if;

  select like_count into v_count from public.forum_replies where id = p_reply_id;
  return jsonb_build_object('liked', v_liked, 'like_count', coalesce(v_count, 0));
end;
$$;

revoke all on function public.toggle_forum_reply_like(uuid) from public;
grant execute on function public.toggle_forum_reply_like(uuid) to authenticated;

-- Varsa eski satırların sayaçlarını düzelt (idempotent).
update public.forum_replies as r
set like_count = coalesce(
  (select count(*) from public.forum_reply_likes as l where l.reply_id = r.id),
  0
);


-- >>> supabase/migrations/20260918120000_username_rpc.sql
-- ============================================================
-- DenizTradeX — Atomik kullanıcı-adı değişimi + bot rozet listesi
--
-- 1) `change_own_username(p_username)`: SECURITY DEFINER RPC.
--    Oturum sahibi kendi adını tek işlemde değiştirir; RLS sessiz
--    retleri bu yolda yaşanmaz (işlem ya olur ya açık hata verir).
--    Aynı satır güncellendiği için eski ad unique kısıttan düşer ve
--    başkası tarafından yeniden alınabilir.
-- 2) Bot rozet listesine 'entes yöneticisi' eklenir (eski 'faik
--    erdem' yazılarının rozeti korunur — listeden ÇIKARILMAZ).
--
-- NOT: bu dosyadaki `change_own_username` çakışma kontrolü
-- (`username ilike v_new`) `_` joker hatası içerir; hemen ardından
-- gelen 20260918150000_username_exact_match bölümü bunu
-- `lower() = lower()` tam-eşleşmeyle düzeltir. Sırayı bozma.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.change_own_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_new text;
begin
  if v_uid is null then
    raise exception 'giriş gerekli';
  end if;

  v_new := trim(both from coalesce(p_username, ''));
  if char_length(v_new) < 3 or char_length(v_new) > 20 then
    raise exception 'geçersiz kullanıcı adı (3-20 karakter olmalı)';
  end if;

  if exists (
    select 1 from public.profiles
    where id <> v_uid and username ilike v_new
  ) then
    raise exception 'Bu kullanıcı adı zaten kullanılıyor.';
  end if;

  update public.profiles
  set username = v_new
  where id = v_uid;

  return jsonb_build_object('ok', true, 'username', v_new);
end;
$$;

revoke all on function public.change_own_username(text) from public;
grant execute on function public.change_own_username(text) to authenticated;

-- ------------------------------------------------------------
-- Bot rozeti: 'entes yöneticisi' eklendi (Faik Erdem adı
-- kullanılmıyor; eski yazıların 'faik erdem' rozeti korunur).
-- ------------------------------------------------------------
create or replace function public.forum_verified_tier(p_user_id uuid, p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- Bot personaları HER ZAMAN mavi tik (user_id süper admin olsa bile).
    when translate(lower(trim(coalesce(p_username, ''))), 'İI' || chr(775), 'iı')
      in ('elon musk', 'entes yöneticisi', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı') then 'admin'
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


-- >>> supabase/migrations/20260918130000_wallet_transfer.sql
-- ============================================================
-- DenizTradeX — Cüzdan numarası + hesaplar arası transfer
--
-- 1) `profiles.wallet_no`: her hesaba benzersiz cüzdan numarası
--    (`WT-XXXXXXXX`). Yeni kayıtlarda trigger üretir, eskiler
--    backfill ile dolar.
-- 2) `transactions.type`: `transfer_in` / `transfer_out` eklenir.
-- 3) `lookup_wallet(p_q)`: cüzdan no veya kullanıcı adından alıcı
--    arar - yalnızca cüzdan no + kullanıcı adı döndürür (bakiye vb.
--    sızmaz).
-- 4) `transfer_assets(p_receiver_wallet, p_asset, p_amount)`:
--    SECURITY DEFINER - USDT bakiye veya coin miktarı gönderir.
--    - USDT: profiles.balance satırları kilitlenerek taşınır.
--    - Spot coin (BTC…): iki tarafın `trading_state.spot_balances`
--      JSONB'si güncellenir (satır yoksa açılır).
--    - Sanal coin (ENTES, V-XAU…): `virtual_holdings` taşınır.
--    Her iki tarafa da defter satırı yazılır.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Cüzdan numarası
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists wallet_no text;

-- Üretici: WT- + id hash'inden 8 büyük harf/rakam.
create or replace function public.make_wallet_no(p_id uuid)
returns text
language sql
immutable
as $$
  select 'WT-' || upper(substring(md5(p_id::text) from 1 for 8));
$$;

-- Mevcut satırlara geriye dönük numara (çakışmada son 4 haneyi id'den alır).
do $$
declare
  r record;
  v_no text;
begin
  for r in select id from public.profiles where wallet_no is null loop
    v_no := public.make_wallet_no(r.id);
    if exists (select 1 from public.profiles where wallet_no = v_no) then
      v_no := 'WT-' || upper(substring(md5(r.id::text || now()::text) from 1 for 8));
    end if;
    update public.profiles set wallet_no = v_no where id = r.id;
  end loop;
end;
$$;

alter table public.profiles
  alter column wallet_no set default public.make_wallet_no(auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_wallet_no_key'
  ) then
    alter table public.profiles add constraint profiles_wallet_no_key unique (wallet_no);
  end if;
end;
$$;

-- Yeni kayıtlarda numara trigger ile garanti altına alınır
-- (auth.uid() varsayılanı RPC bağlamlarında boş kalabilir).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, email, balance, wallet_no)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    coalesce(new.email, ''),
    10000.00,
    public.make_wallet_no(new.id)
  );
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 2) Defter tipleri: transfer giriş/çıkışı
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'transactions_type_check') then
    alter table public.transactions drop constraint transactions_type_check;
  end if;
  alter table public.transactions
    add constraint transactions_type_check
    check (type in ('trade_buy','trade_sell','withdraw','promo','referral','transfer_in','transfer_out'));
end;
$$;

-- ------------------------------------------------------------
-- 3) Alıcı arama (yalnızca cüzdan no + kullanıcı adı döner)
-- ------------------------------------------------------------
create or replace function public.lookup_wallet(p_q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q text := trim(both from coalesce(p_q, ''));
  v_row record;
begin
  if v_q = '' then
    raise exception 'geçersiz arama';
  end if;

  select wallet_no, username into v_row
  from public.profiles
  where upper(wallet_no) = upper(v_q)
  limit 1;

  if not found then
    select wallet_no, username into v_row
    from public.profiles
    where username ilike v_q
    limit 1;
  end if;

  if not found then
    raise exception 'alıcı bulunamadı';
  end if;

  return jsonb_build_object('wallet_no', v_row.wallet_no, 'username', v_row.username);
end;
$$;

revoke all on function public.lookup_wallet(text) from public;
grant execute on function public.lookup_wallet(text) to authenticated;

-- ------------------------------------------------------------
-- 4) Hesaplar arası transfer
-- ------------------------------------------------------------
create or replace function public.transfer_assets(
  p_receiver_wallet text,
  p_asset          text,
  p_amount         numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender   uuid := auth.uid();
  v_receiver uuid;
  v_asset    text := upper(trim(both from coalesce(p_asset, '')));
  v_qty      numeric;
  v_bal      numeric;
  v_hold     numeric;
  v_state    jsonb;
  v_new      numeric;
begin
  if v_sender is null then
    raise exception 'giriş gerekli';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;
  if v_asset = '' then
    raise exception 'geçersiz varlık';
  end if;

  select id into v_receiver
  from public.profiles
  where upper(wallet_no) = upper(trim(both from coalesce(p_receiver_wallet, '')))
  limit 1;
  if not found then
    raise exception 'alıcı bulunamadı';
  end if;
  if v_receiver = v_sender then
    raise exception 'kendine transfer yapamazsın';
  end if;

  if v_asset = 'USDT' then
    select balance into v_bal from public.profiles where id = v_sender for update;
    if v_bal is null then
      raise exception 'profil bulunamadı';
    end if;
    if v_bal < p_amount then
      raise exception 'yetersiz USDT bakiyesi';
    end if;

    update public.profiles set balance = balance - p_amount where id = v_sender;
    update public.profiles set balance = balance + p_amount where id = v_receiver;

    insert into public.transactions (user_id, type, amount_usdt)
    values (v_sender, 'transfer_out', p_amount),
           (v_receiver, 'transfer_in', p_amount);

    return jsonb_build_object('ok', true, 'asset', 'USDT', 'amount', p_amount);
  end if;

  -- Sanal coin mi?
  if exists (select 1 from public.virtual_coins where symbol = v_asset) then
    select quantity into v_hold
    from public.virtual_holdings
    where user_id = v_sender and symbol = v_asset;
    if coalesce(v_hold, 0) < p_amount then
      raise exception 'yetersiz coin bakiyesi';
    end if;

    update public.virtual_holdings
    set quantity = quantity - p_amount
    where user_id = v_sender and symbol = v_asset;

    insert into public.virtual_holdings (user_id, symbol, quantity)
    values (v_receiver, v_asset, p_amount)
    on conflict (user_id, symbol)
    do update set quantity = public.virtual_holdings.quantity + excluded.quantity;

    insert into public.transactions (user_id, type, symbol, side, quantity, amount_usdt)
    values (v_sender, 'transfer_out', v_asset, 'sell', p_amount, p_amount),
           (v_receiver, 'transfer_in', v_asset, 'buy', p_amount, p_amount);

    return jsonb_build_object('ok', true, 'asset', v_asset, 'amount', p_amount);
  end if;

  -- Spot coin: trading_state.spot_balances JSONB taşınır.
  select (spot_balances ->> v_asset)::numeric into v_qty
  from public.trading_state
  where user_id = v_sender;
  if coalesce(v_qty, 0) < p_amount then
    raise exception 'yetersiz coin bakiyesi';
  end if;

  insert into public.trading_state (user_id, spot_balances)
  values (v_sender, '{}'::jsonb)
  on conflict (user_id) do nothing;

  update public.trading_state
  set spot_balances = coalesce(spot_balances, '{}'::jsonb) ||
        jsonb_build_object(v_asset, greatest(coalesce((spot_balances ->> v_asset)::numeric, 0) - p_amount, 0)),
      updated_at = now()
  where user_id = v_sender;

  insert into public.trading_state (user_id, spot_balances)
  values (v_receiver, '{}'::jsonb)
  on conflict (user_id) do nothing;

  update public.trading_state
  set spot_balances = coalesce(spot_balances, '{}'::jsonb) ||
        jsonb_build_object(v_asset, coalesce((spot_balances ->> v_asset)::numeric, 0) + p_amount),
      updated_at = now()
  where user_id = v_receiver;

  insert into public.transactions (user_id, type, symbol, side, quantity, amount_usdt)
  values (v_sender, 'transfer_out', v_asset || 'USDT', 'sell', p_amount, p_amount),
         (v_receiver, 'transfer_in', v_asset || 'USDT', 'buy', p_amount, p_amount);

  return jsonb_build_object('ok', true, 'asset', v_asset, 'amount', p_amount);
end;
$$;

revoke all on function public.transfer_assets(text, text, numeric) from public;
grant execute on function public.transfer_assets(text, text, numeric) to authenticated;


-- >>> supabase/migrations/20260918140000_new_users_restricted.sql
-- ============================================================
-- DenizTradeX — Yeni üyeler kısıtlı başlar
--
-- Yeni kayıt olan hesapların para yatırma + para çekme işlemleri
-- varsayılan olarak KAPALI başlar; yönetici Admin Panel → Kısıtla
-- ekranından tek tek açar. Mevcut hesaplar etkilenmez (yalnızca
-- kolon varsayılanı + tetikleyici değişir).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.profiles
  alter column deposit_blocked set default true;

alter table public.profiles
  alter column withdraw_blocked set default true;

-- handle_new_user transfer migration'ında yeniden tanımlanmıştı;
-- kısıtları açık şekilde kapalı başlatır (varsayılana bel bağlamaz).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles
    (id, username, email, balance, wallet_no, deposit_blocked, withdraw_blocked)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    coalesce(new.email, ''),
    10000.00,
    public.make_wallet_no(new.id),
    true,
    true
  );
  return new;
end;
$$;


-- >>> supabase/migrations/20260918150000_username_exact_match.sql
-- ============================================================
-- DenizTradeX — kullanıcı-adı çakışma kontrolünde tam-eşleşme fix'i
--
-- Hata: `change_own_username` çakışma kontrolü
--   `where id <> v_uid and username ilike v_new`
-- kullanıyordu. `ilike` bir LIKE desenidir: kullanıcı adlarında
-- SERBEST olan `_` tek-karakter jokeridir (`%` çok-karakter).
-- Örnek: boşta olan `eski_ad` adı, veritabanında `eskiAad`
-- (veya `eski1ad`) gibi KOMŞU bir ad varsa desen eşleşmesi yüzünden
-- "dolu" sanılıp `Bu kullanıcı adı zaten kullanılıyor.` hatasıyla
-- reddediliyordu — kullanıcı eski adını geri alamıyordu.
-- Aynı hata istemcideki `findProfileByUsername` / `findProfileByEmail`
-- `ilike` sorgularında da vardı (desen kaçışıyla düzeltildi).
--
-- Çözüm: desen eşleşmesi yerine `lower() = lower()` ile gerçek
-- büyük-küçük harfe duyarsız TAM eşleşme (`resolve_login_email`
-- fonksiyonundaki doğru yaklaşımla aynı). `_`/`%` artık joker değil,
-- sıradan karakterdir.
--
-- NOT: `lookup_wallet` bölümü `profiles.wallet_no` kolonunu gerektirir
-- (20260918130000_wallet_transfer). Bu dosya tek başına çalışırsa o
-- bölüm sessizce atlanır; kronolojik sırada sorun yoktur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.change_own_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_new text;
begin
  if v_uid is null then
    raise exception 'giriş gerekli';
  end if;

  v_new := trim(both from coalesce(p_username, ''));
  if char_length(v_new) < 3 or char_length(v_new) > 20 then
    raise exception 'geçersiz kullanıcı adı (3-20 karakter olmalı)';
  end if;

  -- TAM eşleşme: lower()=lower(). ilike KULLANMA (bkz. dosya başı).
  if exists (
    select 1 from public.profiles
    where id <> v_uid and lower(username) = lower(v_new)
  ) then
    raise exception 'Bu kullanıcı adı zaten kullanılıyor.';
  end if;

  update public.profiles
  set username = v_new
  where id = v_uid;

  return jsonb_build_object('ok', true, 'username', v_new);
end;
$$;

revoke all on function public.change_own_username(text) from public;
grant execute on function public.change_own_username(text) to authenticated;

-- ------------------------------------------------------------
-- Aynı kök neden `lookup_wallet` alıcı aramasında da vardı
-- (transfer ekranı): `where username ilike v_q` deseni
-- `_` içeren adlarda KOMŞU kullanıcıya eşleşebilir ve para
-- yanlış kişiye gidebilirdi. Burada da tam-eşleşmeye çevrildi
-- (cüzdan no karşılaştırması zaten exact `upper() = upper()` idi).
--
-- Koşullu çalışır: `profiles.wallet_no` kolonu yoksa
-- (20260918130000_wallet_transfer henüz uygulanmamışsa) bu bölüm
-- atlanır; kronolojik sırada (bundle dahil) normal uygulanır.
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'wallet_no'
  ) then
    execute $q$
    create or replace function public.lookup_wallet(p_q text)
    returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $fn$
    declare
      v_q text := trim(both from coalesce(p_q, ''));
      v_row record;
    begin
      if v_q = '' then
        raise exception 'geçersiz arama';
      end if;

      select wallet_no, username into v_row
      from public.profiles
      where upper(wallet_no) = upper(v_q)
      limit 1;

      if not found then
        -- TAM eşleşme: lower()=lower(). ilike KULLANMA (bkz. dosya başı).
        select wallet_no, username into v_row
        from public.profiles
        where lower(username) = lower(v_q)
        limit 1;
      end if;

      if not found then
        raise exception 'alıcı bulunamadı';
      end if;

      return jsonb_build_object('wallet_no', v_row.wallet_no, 'username', v_row.username);
    end;
    $fn$
    $q$;

    execute 'revoke all on function public.lookup_wallet(text) from public';
    execute 'grant execute on function public.lookup_wallet(text) to authenticated';
  end if;
end;
$$;

