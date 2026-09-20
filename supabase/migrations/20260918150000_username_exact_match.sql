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
