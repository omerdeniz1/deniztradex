-- ============================================================
-- DenizTradeX — Cüzdan numarası + hesaplar arası transfer
--
-- 1) `profiles.wallet_no`: her hesaba benzersiz cüzdan numarası
--    (`WT-XXXXXXXX`). Yeni kayıtlarda trigger üretir, eskiler
--    backfill ile dolar.
-- 2) `transactions.type`: `transfer_in` / `transfer_out` eklenir.
-- 3) `lookup_wallet(p_q)`: cüzdan no veya kullanıcı adından alıcı
--    arar — yalnızca cüzdan no + kullanıcı adı döndürür (bakiye vb.
--    sızmaz).
-- 4) `transfer_assets(p_receiver_wallet, p_asset, p_amount)`:
--    SECURITY DEFINER — USDT bakiye veya coin miktarı gönderir.
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
    check (type in ('trade_buy','trade_sell','withdraw','promo','referral','transfer_in','transfer_out','fee'));
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
