-- ============================================================
-- DenizTradeX — Oto-bot ücret simetrisi (aşağı kayma düzeltmesi)
--
-- Sorun: tüm havuz matematiğinde alış havuza net tutarı eklerken
-- (`a·(1-f)`) satış BRÜT tutarı çıkarıyordu (`a`). 50/50 rastgele
-- akışta her alış+satış turu havuzdan `a·f` USDT sızdırır, fiyat
-- (`rezerv_usdt / rezerv_token`) güne -%0.2/-0.3 civarı sistematik
-- aşağı kayardı — botlar "sürekli düşürüyor" izlenimi veriyordu.
--
-- Çözüm (SADECE herkeste çalışan oto motor yolları): satış da net
-- tutarla (`a·(1-f)`) hareket eder — alışın birebir aynası. Tur
-- başına beklenen kayma saf dışbükeylik kalıntısına iner (ihmal
-- edilir, ortalama-dönüş bantları zaten dengeler).
--
-- KAPSAM DIŞI (bilerek dokunulmadı): kullanıcı işlemleri
-- (`execute_virtual_trade`) ve manuel karakter-bot hamleleri
-- (`execute_bot_trade`) — orada fiyat etkisi kullanıcı/admin
-- niyetini yansıtır, ekonomi değişmemeli.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) execute_auto_market_trade: simetrik satış bacağı
-- ------------------------------------------------------------
create or replace function public.execute_auto_market_trade(
  p_symbol      text,
  p_trade_type  text,
  p_usdt_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate   constant numeric := 0.003;
  v_cap_frac   constant numeric := 0.002;
  v_cap_abs    constant numeric := 25000;
  v_amount     numeric;
  v_eff        numeric;
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_k          numeric;
  v_token_in   numeric;
  v_token_out  numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_old_price  numeric;
  v_bucket     timestamptz;
begin
  if p_trade_type not in ('buy', 'sell') then
    raise exception 'geçersiz işlem yönü (buy/sell olmalı)';
  end if;

  if p_usdt_amount is null or p_usdt_amount <= 0 then
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

  -- Sunucu cap'i: aşan kısım sessizce kırpılır (hata DEĞİL — motor akmaya devam eder).
  v_amount := least(p_usdt_amount, v_rusdt * v_cap_frac, v_cap_abs);
  if v_amount <= 0 then
    raise exception 'havuz derinliği yetersiz';
  end if;

  v_k := v_rusdt * v_rtoken;

  if p_trade_type = 'buy' then
    v_token_out  := v_rtoken - (v_k / (v_rusdt + v_amount * (1 - v_fee_rate)));
    if v_token_out <= 0 or v_token_out >= v_rtoken then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rusdt := v_rusdt + v_amount * (1 - v_fee_rate);
    v_new_rtoken := v_rtoken - v_token_out;
  else
    -- Simetrik satış: havuzdan çıkan tutar da net (`a·(1-f)`) — alış
    -- bacağının aynası. Brüt tutar hacim raporunda aynen korunur.
    v_eff := v_amount * (1 - v_fee_rate);
    if v_eff >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_token_in := (v_k / (v_rusdt - v_eff)) - v_rtoken;
    if v_token_in is null or v_token_in <= 0 then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken + v_token_in;
    v_new_rusdt := v_rusdt - v_eff;
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_amount
    where symbol = p_symbol;

  -- 1 dakikalık mum upsert (gerçek takasla aynı kural).
  v_bucket := date_trunc('minute', now());
  insert into public.virtual_kline_data
    (symbol, timestamp, open, high, low, close, volume)
  values
    (p_symbol, v_bucket, v_old_price,
     greatest(v_old_price, v_new_price),
     least(v_old_price, v_new_price),
     v_new_price, v_amount)
  on conflict (symbol, timestamp)
  do update set
    high   = greatest(public.virtual_kline_data.high, excluded.high),
    low    = least(public.virtual_kline_data.low, excluded.low),
    close  = excluded.close,
    volume = public.virtual_kline_data.volume + excluded.volume;

  return jsonb_build_object(
    'ok', true,
    'token_amount', case when p_trade_type = 'buy' then v_token_out else v_token_in end,
    'usdt_amount', v_amount,
    'price', v_old_price,
    'new_price', v_new_price,
    'price_impact_pct', ((v_new_price - v_old_price) / v_old_price) * 100
  );
end;
$$;

revoke all on function public.execute_auto_market_trade(text, text, numeric) from public;
grant execute on function public.execute_auto_market_trade(text, text, numeric) to authenticated;

-- ------------------------------------------------------------
-- 2) run_auto_market_bot (pg_cron turu): simetrik satış bacağı
-- ------------------------------------------------------------
create or replace function public.run_auto_market_bot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate   constant numeric := 0.003;
  v_cap_frac   constant numeric := 0.003;
  v_cap_abs    constant numeric := 25000;
  v_band       constant numeric := 0.08;
  v_enabled    boolean := true;
  v_intensity  text := 'normal';
  v_rounds     integer := 4;
  i            integer;
  v_symbol     text;
  v_side       text;
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_price      numeric;
  v_anchor     numeric;
  v_drift      numeric;
  v_amount     numeric;
  v_eff        numeric;
  v_k          numeric;
  v_token_in   numeric;
  v_token_out  numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_bucket     timestamptz;
  v_count      integer := 0;
  v_vol        numeric := 0;
begin
  select coalesce(enabled, true), coalesce(intensity, 'normal')
    into v_enabled, v_intensity
    from public.auto_bot_config
    where id = 1;

  if not coalesce(v_enabled, true) then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;

  v_rounds := case v_intensity
    when 'calm' then 2
    when 'lively' then 6
    else 4
  end;

  for i in 1..v_rounds loop
    -- Rastgele coin (tüm sanal havuzlar aday — DNZ dahil).
    select symbol, reserve_usdt, reserve_token, current_price
      into v_symbol, v_rusdt, v_rtoken, v_price
      from public.virtual_coins
      order by random()
      limit 1
      for update;

    if not found then
      continue;
    end if;

    -- Çapa yoksa (yeni coin) bugünkü fiyat çapadır.
    select anchor_price into v_anchor
      from public.auto_bot_anchor
      where symbol = v_symbol;
    if not found then
      insert into public.auto_bot_anchor (symbol, anchor_price)
      values (v_symbol, v_price)
      on conflict (symbol) do nothing;
      v_anchor := v_price;
    end if;

    -- Yön: bant dışında %75 ters-yön baskısı, bant içinde %50/%50.
    v_drift := (v_price - v_anchor) / v_anchor;
    if v_drift > v_band then
      v_side := case when random() < 0.75 then 'sell' else 'buy' end;
    elsif v_drift < -v_band then
      v_side := case when random() < 0.75 then 'buy' else 'sell' end;
    else
      v_side := case when random() < 0.5 then 'buy' else 'sell' end;
    end if;

    -- Tutar: rezervin %0.04–0.15'i, cap ile kırpılır.
    v_amount := least(
      v_rusdt * (0.0004 + random() * 0.0011),
      v_rusdt * v_cap_frac,
      v_cap_abs
    );
    if v_amount is null or v_amount <= 0 then
      continue;
    end if;

    v_k := v_rusdt * v_rtoken;

    if v_side = 'buy' then
      v_token_out := v_rtoken - (v_k / (v_rusdt + v_amount * (1 - v_fee_rate)));
      if v_token_out is null or v_token_out <= 0 or v_token_out >= v_rtoken then
        continue;
      end if;
      v_new_rusdt := v_rusdt + v_amount * (1 - v_fee_rate);
      v_new_rtoken := v_rtoken - v_token_out;
    else
      -- Simetrik satış (yukarıdaki gerekçe): net tutarla hareket.
      v_eff := v_amount * (1 - v_fee_rate);
      if v_eff >= v_rusdt then
        continue;
      end if;
      v_token_in := (v_k / (v_rusdt - v_eff)) - v_rtoken;
      if v_token_in is null or v_token_in <= 0 then
        continue;
      end if;
      v_new_rtoken := v_rtoken + v_token_in;
      v_new_rusdt := v_rusdt - v_eff;
    end if;

    v_new_price := v_new_rusdt / v_new_rtoken;

    update public.virtual_coins
      set reserve_usdt  = v_new_rusdt,
          reserve_token = v_new_rtoken,
          current_price = v_new_price,
          volume_24h    = volume_24h + v_amount
      where symbol = v_symbol;

    v_bucket := date_trunc('minute', now());
    insert into public.virtual_kline_data
      (symbol, timestamp, open, high, low, close, volume)
    values
      (v_symbol, v_bucket, v_price,
       greatest(v_price, v_new_price),
       least(v_price, v_new_price),
       v_new_price, v_amount)
    on conflict (symbol, timestamp)
    do update set
      high   = greatest(public.virtual_kline_data.high, excluded.high),
      low    = least(public.virtual_kline_data.low, excluded.low),
      close  = excluded.close,
      volume = public.virtual_kline_data.volume + excluded.volume;

    v_count := v_count + 1;
    v_vol := v_vol + v_amount;
  end loop;

  return jsonb_build_object('ok', true, 'trades', v_count, 'volume', v_vol);
end;
$$;

revoke all on function public.run_auto_market_bot() from public;
grant execute on function public.run_auto_market_bot() to authenticated;
