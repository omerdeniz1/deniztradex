-- ============================================================
-- DenizTradeX — Forum karakter sınırı 500 → 5000
--
-- Gönderi + yanıt içerik kontrol kısıtları ve bot mesaj RPC'si
-- 5000 karaktere genişletilir (istemcideki FORUM_POST_MAX_LENGTH
-- ile aynı). Mevcut 500 altı içerikler aynen geçerlidir.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.forum_posts
  drop constraint if exists forum_posts_content_check;

alter table public.forum_posts
  add constraint forum_posts_content_check
  check (char_length(content) between 1 and 5000);

alter table public.forum_replies
  drop constraint if exists forum_replies_content_check;

alter table public.forum_replies
  add constraint forum_replies_content_check
  check (char_length(content) between 1 and 5000);

-- Bot mesaj RPC'si: limit 5000 (sahte-beğeni tabanı + vitrin adı
-- mantığı 20260924000000 sürümünden aynen korunur).
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
  if char_length(p_content) > 5000 then
    raise exception 'mesaj en fazla 5000 karakter olabilir';
  end if;

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

revoke all on function public.post_bot_message(text, text, integer) from public;
grant execute on function public.post_bot_message(text, text, integer) to authenticated;
