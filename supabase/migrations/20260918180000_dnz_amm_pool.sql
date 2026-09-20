-- ============================================================
-- DenizTradeX — DNZ sanal AMM havuzu (borsa tokenı havuza taşındı)
--
-- Karar: DNZ, diğer sanal coinler gibi x*y=k havuzunda işlem görür
-- (fiyat etkisi + mum grafiği + sanal panel aynen gelir).
--  - Havuz: 100.000.000 USDT / 200.000.000 DNZ → açılış $0.50.
--    Arzın tamamı başlangıçta havuzdadır; alımlar dolaşıma çıkarır.
--  - Bakiyeler `dnz_balances`, hareketler `dnz_ledger` tablosunda
--    kalır (komisyon indirimi + transfer + cüzdan aynen çalışır);
--    `virtual_holdings` DNZ için KULLANILMAZ.
--  - `execute_dnz_trade`: `execute_virtual_trade` ile birebir aynı
--    imza + matematik, tek fark DNZ bacağı `dnz_balances`/`dnz_ledger`
--    defterine işlenir (ayrıca 1dk mumu upsert edilir — bot kuralı).
--
-- Gereksinim: 20260916130000_virtual_market (havuz/RPC),
--   20260918170000_dnz_token (dnz defterleri).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) DNZ havuzu (arzın tamamı havuzda başlar; öne çıkan).
-- ------------------------------------------------------------
insert into public.virtual_coins (symbol, name, type, reserve_usdt, reserve_token, current_price, status)
values ('DNZ', 'DNZ Token', 'crypto', 100000000, 200000000, 0.5, 'promoted')
on conflict (symbol) do nothing;

-- ------------------------------------------------------------
-- 2) DNZ takas RPC'si (havuz + dnz defterleri, satır kilitli).
--    İmza/anlam `execute_virtual_trade` ile birebir:
--    buy:  p_amount = yatırılan USDT → DNZ çıkar,
--    sell: p_amount = satılan DNZ adedi → USDT çıkar.
-- ------------------------------------------------------------
create or replace function public.execute_dnz_trade(
  p_user_id   uuid,
  p_side      text,
  p_amount    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate   constant numeric := 0.003;
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_k          numeric;
  v_in_after   numeric;
  v_token_out  numeric;
  v_usdt_out   numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_old_price  numeric;
  v_balance    numeric;
  v_holding    numeric;
  v_bucket     timestamptz;
begin
  -- Kimlik: kullanıcı yalnızca kendi adına işlem yapar.
  if auth.uid() is distinct from p_user_id then
    raise exception 'yetkisiz işlem: kendi hesabın için işlem yapabilirsin';
  end if;

  if p_side not in ('buy', 'sell') then
    raise exception 'geçersiz işlem yönü (buy/sell olmalı)';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  select reserve_usdt, reserve_token, current_price
    into v_rusdt, v_rtoken, v_old_price
    from public.virtual_coins
    where symbol = 'DNZ'
    for update;

  if not found then
    raise exception 'coin bulunamadı';
  end if;

  v_k := v_rusdt * v_rtoken;

  if p_side = 'buy' then
    -- USDT bakiyesi yeterli mi?
    select balance into v_balance from public.profiles where id = p_user_id for update;
    if v_balance is null then
      raise exception 'profil bulunamadı';
    end if;
    if v_balance < p_amount then
      raise exception 'yetersiz USDT bakiyesi';
    end if;

    v_in_after  := p_amount * (1 - v_fee_rate);
    v_new_rusdt := v_rusdt + v_in_after;
    v_token_out := v_rtoken - (v_k / v_new_rusdt);
    if v_token_out <= 0 or v_token_out >= v_rtoken then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken - v_token_out;
    v_usdt_out   := p_amount;

    update public.profiles
      set balance = balance - p_amount
      where id = p_user_id;

    insert into public.dnz_balances (user_id, balance)
    values (p_user_id, v_token_out)
    on conflict (user_id)
    do update set balance = public.dnz_balances.balance + excluded.balance,
                  updated_at = now();

    insert into public.dnz_ledger (user_id, type, amount_dnz, price_usdt, amount_usdt, balance_after)
    values (p_user_id, 'buy', v_token_out, v_old_price, v_usdt_out,
      (select balance from public.dnz_balances where user_id = p_user_id));

  else
    -- DNZ bakiyesi yeterli mi?
    select balance into v_holding
      from public.dnz_balances
      where user_id = p_user_id;
    if coalesce(v_holding, 0) < p_amount then
      raise exception 'yetersiz coin bakiyesi';
    end if;

    v_in_after   := p_amount * (1 - v_fee_rate);
    v_new_rtoken := v_rtoken + v_in_after;
    v_usdt_out   := v_rusdt - (v_k / v_new_rtoken);
    if v_usdt_out <= 0 or v_usdt_out >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rusdt := v_rusdt - v_usdt_out;
    v_token_out := p_amount;

    update public.dnz_balances
      set balance = balance - p_amount, updated_at = now()
      where user_id = p_user_id;

    update public.profiles
      set balance = balance + v_usdt_out
      where id = p_user_id;

    insert into public.dnz_ledger (user_id, type, amount_dnz, price_usdt, amount_usdt, balance_after)
    values (p_user_id, 'sell', v_token_out, v_old_price, v_usdt_out,
      (select balance from public.dnz_balances where user_id = p_user_id));
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_usdt_out
    where symbol = 'DNZ';

  -- 1 dakikalık mum upsert (bot takaslarıyla aynı kural).
  v_bucket := date_trunc('minute', now());
  insert into public.virtual_kline_data
    (symbol, timestamp, open, high, low, close, volume)
  values
    ('DNZ', v_bucket, v_old_price,
     greatest(v_old_price, v_new_price),
     least(v_old_price, v_new_price),
     v_new_price, v_usdt_out)
  on conflict (symbol, timestamp)
  do update set
    high   = greatest(public.virtual_kline_data.high, excluded.high),
    low    = least(public.virtual_kline_data.low, excluded.low),
    close  = excluded.close,
    volume = public.virtual_kline_data.volume + excluded.volume;

  return jsonb_build_object(
    'ok', true,
    'token_amount', v_token_out,
    'usdt_amount', v_usdt_out,
    'price', v_old_price,
    'new_price', v_new_price,
    'price_impact_pct', ((v_new_price - v_old_price) / v_old_price) * 100
  );
end;
$$;

revoke all on function public.execute_dnz_trade(uuid, text, numeric) from public;
grant execute on function public.execute_dnz_trade(uuid, text, numeric) to authenticated;
