-- ============================================================
-- DenizTradeX — Sanal coin mum verisi (kendi grafik altyapımız)
--
-- `virtual_kline_data`: 1 dakikalık mumlar. Gerçek coinlerde mumlar
-- Binance'den gelir; sanal coinlerde (ENTES, V-XAU, ...) grafik
-- DOĞRUDAN bu tablodan çizilir.
--
-- Yazım: `execute_virtual_trade` her takasta içinde bulunulan dakikanın
-- mumunu upsert eder (open ilk fiyat, high/low uçlar, close son fiyat,
-- volume USDT bacağı toplamı).
--
-- Geçmiş: migration anında her coine 300 adet 1 dakikalık mum tohumlanır
-- (mevcut fiyata biten geriye-yürüyen rastgele yürüyüş), grafik ilk
-- günden canlı görünür.
--
-- Idempotent: tablo/seed tekrar çalıştırılabilir (mumlar çakışırsa atlanır).
-- ============================================================

create table if not exists public.virtual_kline_data (
  id        bigint generated always as identity primary key,
  symbol    text not null references public.virtual_coins (symbol) on delete cascade,
  timestamp timestamptz not null,
  open      numeric not null,
  high      numeric not null,
  low       numeric not null,
  close     numeric not null,
  volume    numeric not null default 0,
  unique (symbol, timestamp)
);

create index if not exists virtual_kline_symbol_time_idx
  on public.virtual_kline_data (symbol, timestamp desc);

alter table public.virtual_kline_data enable row level security;

-- Mumlar herkese açık vitrin (grafik her giriş yapmış kullanıcıya çizilir).
drop policy if exists virtual_kline_select_all on public.virtual_kline_data;
create policy virtual_kline_select_all
  on public.virtual_kline_data for select
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- execute_virtual_trade: mum upsert'i ekle (önceki sürümün üstüne yazar).
-- ------------------------------------------------------------
create or replace function public.execute_virtual_trade(
  p_user_id   uuid,
  p_symbol    text,
  p_trade_type text,
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

  if p_trade_type not in ('buy', 'sell') then
    raise exception 'geçersiz işlem yönü (buy/sell olmalı)';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  select reserve_usdt, reserve_token, current_price
    into v_rusdt, v_rtoken, v_old_price
    from public.virtual_coins
    where symbol = p_symbol
    for update;

  if not found then
    raise exception 'coin bulunamadı';
  end if;

  v_k := v_rusdt * v_rtoken;

  if p_trade_type = 'buy' then
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

    insert into public.virtual_holdings (user_id, symbol, quantity)
      values (p_user_id, p_symbol, v_token_out)
      on conflict (user_id, symbol)
      do update set quantity = public.virtual_holdings.quantity + excluded.quantity;

  else
    -- Token bakiyesi yeterli mi?
    select quantity into v_holding
      from public.virtual_holdings
      where user_id = p_user_id and symbol = p_symbol;
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

    update public.virtual_holdings
      set quantity = quantity - p_amount
      where user_id = p_user_id and symbol = p_symbol;

    update public.profiles
      set balance = balance + v_usdt_out
      where id = p_user_id;
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_usdt_out
    where symbol = p_symbol;

  -- 1 dakikalık mum upsert: open ilk fiyat, close son fiyat.
  v_bucket := date_trunc('minute', now());
  insert into public.virtual_kline_data
    (symbol, timestamp, open, high, low, close, volume)
  values
    (p_symbol, v_bucket, v_old_price,
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

revoke all on function public.execute_virtual_trade(uuid, text, text, numeric) from public;
grant execute on function public.execute_virtual_trade(uuid, text, text, numeric) to authenticated;

-- ------------------------------------------------------------
-- Geçmiş tohumlama: her coine 300 adet 1 dakikalık mum (mevcut
-- fiyata biten geriye-yürüyen yürüyüş; volatilite havu sığlığına göre).
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_vol numeric;
  v_closes numeric[];
  v_ts timestamptz;
  v_o numeric;
  v_h numeric;
  v_l numeric;
  v_c numeric;
  v_v numeric;
  j integer;
  i integer;
begin
  for r in
    select symbol, current_price, reserve_usdt from public.virtual_coins
  loop
    -- Derin havuz (ENTES/V-XAU/V-XAG): sakin; sığ havuz: hareketli.
    v_vol := case r.symbol
      when 'ENTES' then 0.0006
      when 'V-XAU' then 0.0004
      when 'V-XAG' then 0.0008
      when 'RGC'   then 0.004
      when 'MPRC'  then 0.006
      else 0.010
    end;

    -- Kapanış zinciri güncelden eskiye kurulur: v_closes[1] güncel mum
    -- (güncel fiyat), v_closes[300] en eski mum. Dizi 1-tabanlıdır.
    v_closes := array[r.current_price];
    for j in 1..299 loop
      v_closes := v_closes || (v_closes[j] / (1 + (random() - 0.5) * v_vol * 2));
    end loop;

    for i in reverse 0..299 loop
      v_ts := date_trunc('minute', now()) - (i || ' minutes')::interval;
      v_c := v_closes[i + 1];
      v_o := v_c * (1 + (random() - 0.5) * v_vol);
      v_h := greatest(v_o, v_c) * (1 + random() * v_vol * 0.5);
      v_l := least(v_o, v_c) * (1 - random() * v_vol * 0.5);
      v_v := r.reserve_usdt * v_vol * (0.5 + random());
      insert into public.virtual_kline_data
        (symbol, timestamp, open, high, low, close, volume)
      values (r.symbol, v_ts, v_o, v_h, v_l, v_c, v_v)
      on conflict (symbol, timestamp) do nothing;
    end loop;
  end loop;
end;
$$;
