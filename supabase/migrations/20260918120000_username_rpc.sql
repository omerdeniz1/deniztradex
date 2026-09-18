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
