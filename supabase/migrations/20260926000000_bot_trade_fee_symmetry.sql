-- ============================================================
-- DenizTradeX — Bot hamlesi ücret simetrisi (sürekli düşüş düzeltmesi)
--
-- Sorun: `execute_bot_trade` satış bacağı BRÜT tutarı havuzdan
-- çıkarıyordu (`a`), alış ise net tutarı ekliyordu (`a·(1-f)`).
-- Perakende bot (%50 al / %50 sat) + karakter botları bu yoldan
-- geçtiği için her alış+satış turu havuzdan `a·f` USDT sızdırıp
-- fiyatı sistematik aşağı kaydırıyordu — "botlar sürekli satıyor,
-- coinler hep düşüyor" şikâyetinin kökü buydu.
--
-- Çözüm (oto motor düzeltmesiyle AYNI kural): satış da net tutarla
-- (`a·(1-f)`) hareket eder — alışın birebir aynası. Tur başına
-- beklenen kayma sıfıra iner, 50/50 akış nötr olur. Brüt tutar hacim
-- raporunda (`volume_24h`, `usdt_amount`) aynen korunur.
--
-- KAPSAM DIŞI (bilerek dokunulmadı): kullanıcı işlemleri
-- (`execute_virtual_trade`, `execute_dnz_trade`) — orada ücret
-- ekonomi gereğidir, fiyat etkisi kullanıcı niyetini yansıtır.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.execute_bot_trade(
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
  v_rusdt      numeric;
  v_rtoken     numeric;
  v_k          numeric;
  v_eff        numeric;
  v_token_in   numeric;
  v_token_out  numeric;
  v_usdt_out   numeric;
  v_new_rusdt  numeric;
  v_new_rtoken numeric;
  v_new_price  numeric;
  v_old_price  numeric;
  v_volume     numeric;
  v_bucket     timestamptz;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin bot çalıştırabilir';
  end if;

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

  v_k := v_rusdt * v_rtoken;

  if p_trade_type = 'buy' then
    v_token_out  := v_rtoken - (v_k / (v_rusdt + p_usdt_amount * (1 - v_fee_rate)));
    if v_token_out <= 0 or v_token_out >= v_rtoken then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rusdt := v_rusdt + p_usdt_amount * (1 - v_fee_rate);
    v_new_rtoken := v_rtoken - v_token_out;
    v_usdt_out  := p_usdt_amount;
    v_volume    := p_usdt_amount;
  else
    -- Simetrik satış: havuzdan çıkan tutar da net (`a·(1-f)`) — alış
    -- bacağının aynası. Brüt tutar hacim raporunda aynen korunur.
    v_eff := p_usdt_amount * (1 - v_fee_rate);
    if v_eff >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_token_in := (v_k / (v_rusdt - v_eff)) - v_rtoken;
    if v_token_in is null or v_token_in <= 0 then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken + v_token_in;
    v_new_rusdt := v_rusdt - v_eff;
    v_token_out := v_token_in;
    v_usdt_out  := p_usdt_amount;
    v_volume    := p_usdt_amount;
  end if;

  v_new_price := v_new_rusdt / v_new_rtoken;

  update public.virtual_coins
    set reserve_usdt  = v_new_rusdt,
        reserve_token = v_new_rtoken,
        current_price = v_new_price,
        volume_24h    = volume_24h + v_volume
    where symbol = p_symbol;

  -- 1 dakikalık mum upsert (gerçek takasla aynı kural).
  v_bucket := date_trunc('minute', now());
  insert into public.virtual_kline_data
    (symbol, timestamp, open, high, low, close, volume)
  values
    (p_symbol, v_bucket, v_old_price,
     greatest(v_old_price, v_new_price),
     least(v_old_price, v_new_price),
     v_new_price, v_volume)
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

revoke all on function public.execute_bot_trade(text, text, numeric) from public;
grant execute on function public.execute_bot_trade(text, text, numeric) to authenticated;
