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
