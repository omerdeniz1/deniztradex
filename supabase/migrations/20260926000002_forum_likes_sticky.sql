-- ============================================================
-- DenizTradeX — Sahte beğeni yapışkanlığı (gel-git düzeltmesi)
--
-- Sorun: `sync_forum_like_count` eski kurulumlarda tabansızdı
-- (`like_count = gerçek sayısı`). Bot/persona gönderisinde ilk GERÇEK
-- beğeni sahte tabanı (20B–180B) sıfırlıyordu; ayrıca tetikleyici
-- eksik/yanlış sürümde kalan DB'lerde sayaç her beğenide tabanla
-- gerçek arasında gidip geliyordu.
--
-- Çözüm:
--   1) Sayaç tanımı yeniden doğrulanır: taban + gerçek (asla sıfırlamaz).
--   2) Tetikleyici yeniden kurulur (eksik DB'de takılır).
--   3) Geçmişte silinmiş sayaçlar onarılır: `base_likes > 0` olup
--      `like_count < base_likes` kalan satırlar
--      `base_likes + gerçek` değerine çekilir (gerçekler korunur).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- 1) Sayaç: taban + gerçek (gerçek beğeni tabanı SIFIRLAMAZ).
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

-- 2) Tetikleyici (yoksa takılır, varsa aynen korunur).
drop trigger if exists forum_likes_count_trigger on public.forum_likes;
create trigger forum_likes_count_trigger
  after insert or delete on public.forum_likes
  for each row execute function public.sync_forum_like_count();

-- 3) Silinmiş sayaçları onar (tabanı olup altında kalanlar).
update public.forum_posts as p
set like_count = coalesce(p.base_likes, 0) + coalesce(
  (select count(*) from public.forum_likes as l where l.post_id = p.id),
  0
)
where coalesce(p.base_likes, 0) > 0
  and p.like_count < coalesce(p.base_likes, 0);
