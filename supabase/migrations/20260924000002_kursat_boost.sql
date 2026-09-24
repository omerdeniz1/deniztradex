-- ============================================================
-- DenizTradeX — kursat_tuzmen vitrin büyütmesi
--
-- `kursat_tuzmen` gerçek kullanıcı olarak kalır (persona DEĞİLDİR —
-- profil sayfasındaki "Profili düzenle" çalışmaya devam eder):
--   - Takipçi: `profiles.follower_base = 1.000.000` (gerçek takipler
--     üstüne eklenir, profilde "1 Mn" görünür).
--   - Beğeni: mevcut gönderilerinin tabanı 30B–180B... yerine
--     30.000–200.000 bandına çekilir (gerçek beğeniler korunur);
--     GELECEK gönderilerine aynı bant otomatik basılır (insert
--     tetikleyicisi — bot RPC'si tabanını ezmez, yalnızca tabansız
--     (`base_likes = 0`) satırlara yazar).
--
-- Hesap henüz kayıtlı değilse veri adımları sessizce atlanır
-- (NOTICE basılır) — önce kullanıcının kaydolması gerekir.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- Kolonlar eski kurulumda yoksa ekle (bu dosya tek başına da çalışsın —
-- tetikleyici eksik kolonda her forum insertini patlatırdı).
alter table public.forum_posts
  add column if not exists base_likes integer not null default 0
    check (base_likes >= 0);
alter table public.profiles
  add column if not exists follower_base bigint not null default 0
    check (follower_base >= 0);

do $$
declare
  v_exists boolean := false;
  v_has_likes boolean := false;
  r record;
  v_base integer;
  v_real integer;
begin
  select exists (
    select 1 from public.profiles
    where lower(trim(username)) = 'kursat_tuzmen'
  ) into v_exists;

  if not v_exists then
    raise notice 'kursat_tuzmen profili bulunamadı — önce hesabın kaydolması gerekli, adımlar atlandı.';
    return;
  end if;

  -- 1) Takipçi tabanı: 1 milyon.
  update public.profiles
  set follower_base = 1000000
  where lower(trim(username)) = 'kursat_tuzmen';

  -- 2) Mevcut gönderiler: 30.000–200.000 taban (gerçekler korunur).
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'forum_likes'
  ) into v_has_likes;

  for r in
    select id from public.forum_posts
    where lower(trim(username)) = 'kursat_tuzmen'
  loop
    v_real := 0;
    if v_has_likes then
      select count(*) into v_real from public.forum_likes where post_id = r.id;
    end if;
    v_base := 30000 + floor(random() * 170001)::integer;
    update public.forum_posts
    set base_likes = v_base,
        like_count = v_base + coalesce(v_real, 0)
    where id = r.id;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 3) Gelecek gönderiler: tabansız satıra 30.000–200.000 bas
-- ------------------------------------------------------------
create or replace function public.forum_kursat_base()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base integer;
begin
  if lower(trim(coalesce(NEW.username, ''))) = 'kursat_tuzmen'
     and coalesce(NEW.base_likes, 0) = 0 then
    v_base := 30000 + floor(random() * 170001)::integer;
    NEW.base_likes := v_base;
    NEW.like_count := v_base + coalesce(NEW.like_count, 0);
  end if;
  return NEW;
end;
$$;

drop trigger if exists forum_posts_kursat_base on public.forum_posts;
create trigger forum_posts_kursat_base
  before insert on public.forum_posts
  for each row execute function public.forum_kursat_base();
