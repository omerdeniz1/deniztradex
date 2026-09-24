-- ============================================================
-- DenizTradeX — Bot beğenileri: 20B–180B bandı + yapışkan taban
--
-- İki sorun giderilir:
--  1) Sahte beğeni SİLİNİYORDU: persona-dışı bot adları
--     ('Elon Musk', 'Entes Yöneticisi', 'İlham Memiş', 'Kripto
--     Kaplanı') için `base_likes = 0` yazılıyordu; ilk GERÇEK
--     beğenide `sync_forum_like_count` tetikleyicisi
--     `like_count = taban(0) + gerçek` diye yeniden hesaplayıp
--     sahte beğeniyi sıfırlıyordu. Artık sahte beğeni HER bot
--     gönderisinde tabana yazılır — gerçek beğeni üstüne eklenir,
--     asla sıfırlamaz.
--  2) Bant 10–20B idi; yeni vitrin bandı 20B–180B. Mevcut bot/
--     persona gönderileri gerçek beğenileri korunarak bu banda
--     yeniden çekilir; yeni gönderiler istemciden 20–180B arası
--     rastgele `p_fake_likes` ile gelir.
--
-- Idempotent: tekrar çalıştırılabilir (gerçek beğeniler korunur).
-- ============================================================

-- Kolon eski kurulumda yoksa ekle (bu dosya tek başına da çalışsın).
alter table public.forum_posts
  add column if not exists base_likes integer not null default 0
    check (base_likes >= 0);

-- ------------------------------------------------------------
-- 1) post_bot_message: sahte beğeni = taban (tüm bot adları)
--    (görünen-isim damgası 20260923000003 sürümünden aynen korunur)
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
  -- Sahte beğeni tabana yazılır: ilk gerçek beğenide tetikleyici
  -- `taban + gerçek` hesaplar, sahte asla silinmez.
  v_base integer := greatest(coalesce(p_fake_likes, 0), 0);
  v_display text := trim(coalesce(p_username, ''));
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

  -- Persona vitrin adını kullan (yoksa bot kullanıcı adı).
  select display_name into v_display
  from public.persona_profiles
  where lower(username) = lower(trim(p_username));
  if not found or coalesce(trim(v_display), '') = '' then
    v_display := trim(p_username);
  end if;

  insert into public.forum_posts (user_id, username, content, like_count, base_likes)
  values (v_uid, trim(p_username), trim(p_content), v_base, v_base)
  returning id into v_id;

  update public.forum_posts
    set verified_tier = 'admin',
        is_verified = true,
        avatar_url = null,
        display_name = v_display
    where id = v_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 2) Mevcut bot/persona gönderilerini 20B–180B bandına çek
--    (gerçek beğeniler `forum_likes` sayımından korunur)
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_base integer;
  v_real integer;
  v_has_likes boolean := false;
begin
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'forum_likes'
  ) into v_has_likes;

  for r in
    select id from public.forum_posts
    where translate(lower(trim(username)), 'İI' || chr(775), 'iı') in (
      'deniztradex', 'deniztradexx',
      'omerbabaparayapmakta', 'blackrock',
      'elon musk', 'entes yöneticisi',
      'faik erdem', 'ilham memiş', 'ihsan memiş',
      'kripto kaplanı'
    )
  loop
    v_real := 0;
    if v_has_likes then
      select count(*) into v_real from public.forum_likes where post_id = r.id;
    end if;
    v_base := 20000 + floor(random() * 160001)::integer;
    update public.forum_posts
    set base_likes = v_base,
        like_count = v_base + coalesce(v_real, 0)
    where id = r.id;
  end loop;
end;
$$;
