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
