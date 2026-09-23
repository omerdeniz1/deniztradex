-- ============================================================
-- DenizTradeX — Transfer geçmişinde karşı taraf adı
--
-- `transactions.counterparty`: transfer satırlarına diğer tarafın
-- kullanıcı adı işlenir (gönderende alıcı, alıcıda gönderen). Geçmiş
-- ekranı "Giden · USDT · ahmet" gibi gösterir. Eski satırlar boş kalır.
-- Ücret (%1.2) ve görünen-isim mantığı aynen korunur (tam fonksiyon
-- gövdeleri karşı taraf satırlarıyla güncellenir).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.transactions
  add column if not exists counterparty text not null default '';

-- ------------------------------------------------------------
-- transfer_assets: karşı taraflı (%1.2 ücretli)
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
  v_fee_rate constant numeric := 0.012;
  v_fee      numeric;
  v_total    numeric;
  v_qty      numeric;
  v_bal      numeric;
  v_hold     numeric;
  v_sender_name text;
  v_receiver_name text;
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

  v_fee := p_amount * v_fee_rate;
  v_total := p_amount + v_fee;

  select id, username into v_receiver, v_receiver_name
  from public.profiles
  where upper(wallet_no) = upper(trim(both from coalesce(p_receiver_wallet, '')))
  limit 1;
  if not found then
    raise exception 'alıcı bulunamadı';
  end if;
  if v_receiver = v_sender then
    raise exception 'kendine transfer yapamazsın';
  end if;

  select username into v_sender_name from public.profiles where id = v_sender;

  if v_asset = 'USDT' then
    select balance into v_bal from public.profiles where id = v_sender for update;
    if v_bal is null then
      raise exception 'profil bulunamadı';
    end if;
    if v_bal < v_total then
      raise exception 'yetersiz USDT bakiyesi (ücret dahil)';
    end if;

    update public.profiles set balance = balance - v_total where id = v_sender;
    update public.profiles set balance = balance + p_amount where id = v_receiver;

    insert into public.transactions (user_id, type, amount_usdt, counterparty)
    values (v_sender, 'transfer_out', p_amount, coalesce(v_receiver_name, '')),
           (v_sender, 'fee', v_fee, ''),
           (v_receiver, 'transfer_in', p_amount, coalesce(v_sender_name, ''));

    return jsonb_build_object('ok', true, 'asset', 'USDT', 'amount', p_amount, 'fee', v_fee);
  end if;

  -- Sanal coin mi?
  if exists (select 1 from public.virtual_coins where symbol = v_asset) then
    select quantity into v_hold
    from public.virtual_holdings
    where user_id = v_sender and symbol = v_asset;
    if coalesce(v_hold, 0) < v_total then
      raise exception 'yetersiz coin bakiyesi (ücret dahil)';
    end if;

    update public.virtual_holdings
    set quantity = quantity - v_total
    where user_id = v_sender and symbol = v_asset;

    insert into public.virtual_holdings (user_id, symbol, quantity)
    values (v_receiver, v_asset, p_amount)
    on conflict (user_id, symbol)
    do update set quantity = public.virtual_holdings.quantity + excluded.quantity;

    insert into public.transactions (user_id, type, symbol, side, quantity, amount_usdt, counterparty)
    values (v_sender, 'transfer_out', v_asset, 'sell', p_amount, p_amount, coalesce(v_receiver_name, '')),
           (v_sender, 'fee', v_asset, 'sell', v_fee, v_fee, ''),
           (v_receiver, 'transfer_in', v_asset, 'buy', p_amount, p_amount, coalesce(v_sender_name, ''));

    return jsonb_build_object('ok', true, 'asset', v_asset, 'amount', p_amount, 'fee', v_fee);
  end if;

  -- Spot coin: trading_state.spot_balances JSONB taşınır.
  select (spot_balances ->> v_asset)::numeric into v_qty
  from public.trading_state
  where user_id = v_sender;
  if coalesce(v_qty, 0) < v_total then
    raise exception 'yetersiz coin bakiyesi (ücret dahil)';
  end if;

  insert into public.trading_state (user_id, spot_balances)
  values (v_sender, '{}'::jsonb)
  on conflict (user_id) do nothing;

  update public.trading_state
  set spot_balances = coalesce(spot_balances, '{}'::jsonb) ||
        jsonb_build_object(v_asset, greatest(coalesce((spot_balances ->> v_asset)::numeric, 0) - v_total, 0)),
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

  insert into public.transactions (user_id, type, symbol, side, quantity, amount_usdt, counterparty)
  values (v_sender, 'transfer_out', v_asset || 'USDT', 'sell', p_amount, p_amount, coalesce(v_receiver_name, '')),
         (v_sender, 'fee', v_asset || 'USDT', 'sell', v_fee, v_fee, ''),
         (v_receiver, 'transfer_in', v_asset || 'USDT', 'buy', p_amount, p_amount, coalesce(v_sender_name, ''));

  return jsonb_build_object('ok', true, 'asset', v_asset, 'amount', p_amount, 'fee', v_fee);
end;
$$;

revoke all on function public.transfer_assets(text, text, numeric) from public;
grant execute on function public.transfer_assets(text, text, numeric) to authenticated;

-- ------------------------------------------------------------
-- transfer_dnz: karşı taraflı (%1.2 ücretli)
-- ------------------------------------------------------------
create or replace function public.transfer_dnz(
  p_receiver_wallet text,
  p_amount          numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender   uuid := auth.uid();
  v_receiver uuid;
  v_qty      numeric := p_amount;
  v_fee_rate constant numeric := 0.012;
  v_fee      numeric;
  v_total    numeric;
  v_bal      numeric;
  v_sender_name text;
  v_receiver_name text;
begin
  if v_sender is null then
    raise exception 'giriş gerekli';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  v_fee := v_qty * v_fee_rate;
  v_total := v_qty + v_fee;

  select id, username into v_receiver, v_receiver_name
  from public.profiles
  where upper(wallet_no) = upper(trim(both from coalesce(p_receiver_wallet, '')))
  limit 1;
  if not found then
    raise exception 'alıcı bulunamadı';
  end if;
  if v_receiver = v_sender then
    raise exception 'kendine transfer yapamazsın';
  end if;

  select username into v_sender_name from public.profiles where id = v_sender;

  select balance into v_bal
  from public.dnz_balances
  where user_id = v_sender
  for update;
  if coalesce(v_bal, 0) < v_total then
    raise exception 'yetersiz DNZ bakiyesi (ücret dahil)';
  end if;

  update public.dnz_balances
  set balance = balance - v_total, updated_at = now()
  where user_id = v_sender;

  insert into public.dnz_balances (user_id, balance)
  values (v_receiver, v_qty)
  on conflict (user_id)
  do update set balance = public.dnz_balances.balance + excluded.balance,
                updated_at = now();

  insert into public.dnz_ledger (user_id, type, amount_dnz, balance_after)
  values
    (v_sender, 'transfer_out', v_qty, coalesce(v_bal, 0) - v_total),
    (v_receiver, 'transfer_in', v_qty,
      (select balance from public.dnz_balances where user_id = v_receiver));

  insert into public.transactions (user_id, type, symbol, side, quantity, counterparty)
  values (v_sender, 'transfer_out', 'DNZ', 'sell', v_qty, coalesce(v_receiver_name, '')),
         (v_sender, 'fee', 'DNZ', 'sell', v_fee, ''),
         (v_receiver, 'transfer_in', 'DNZ', 'buy', v_qty, coalesce(v_sender_name, ''));

  return jsonb_build_object('ok', true, 'asset', 'DNZ', 'amount', v_qty, 'fee', v_fee);
end;
$$;

revoke all on function public.transfer_dnz(text, numeric) from public;
grant execute on function public.transfer_dnz(text, numeric) to authenticated;

-- ------------------------------------------------------------
-- Takipçi / takip edilen listeleri (profil kartındaki sayaçlar
-- tıklanabilir; Twitter tarzı üye listesi).
-- ------------------------------------------------------------
create or replace function public.list_follows(p_username text, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text := lower(trim(coalesce(p_username, '')));
begin
  if v_key = '' then
    return jsonb_build_array();
  end if;

  if p_kind = 'following' then
    return coalesce((
      select jsonb_agg(t order by t.at desc)
      from (
        select
          coalesce(pp.display_name, pr.username, f.following_username) as display,
          f.following_username as handle,
          coalesce(pp.avatar_url, pr.avatar_url) as avatar,
          coalesce(
            pp.verified_tier,
            case when pr.id is null then 'none'
                 else public.forum_verified_tier(pr.id, pr.username) end
          ) as tier,
          f.created_at as at
        from public.forum_follows as f
        left join public.persona_profiles as pp
          on lower(pp.username) = f.following_username
        left join public.profiles as pr
          on lower(pr.username) = f.following_username
        where f.follower_id = (
          select id from public.profiles where lower(username) = v_key
        )
        order by f.created_at desc
        limit 100
      ) as t
    ), jsonb_build_array());
  end if;

  -- followers: takip edenler her zaman gerçek kullanıcıdır.
  return coalesce((
    select jsonb_agg(t order by t.at desc)
    from (
      select
        coalesce(nullif(trim(pr.display_name), ''), pr.username) as display,
        pr.username as handle,
        pr.avatar_url as avatar,
        public.forum_verified_tier(pr.id, pr.username) as tier,
        f.created_at as at
      from public.forum_follows as f
      join public.profiles as pr on pr.id = f.follower_id
      where f.following_username = v_key
      order by f.created_at desc
      limit 100
    ) as t
  ), jsonb_build_array());
end;
$$;

revoke all on function public.list_follows(text, text) from public;
grant execute on function public.list_follows(text, text) to anon, authenticated;
