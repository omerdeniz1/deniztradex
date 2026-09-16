-- ============================================================
-- DenizTradeX — Bot Simülasyon Motoru (piyasa manipülasyon testleri)
--
-- KULLANIM: YALNIZCA süper admin (Admin → Bot Test Paneli). Botlar
-- forumda mesaj paylaşıp sanal havuzlarda balina hamlesi yapar; grafik
-- ve piyasa listesi gerçek işlemdeki gibi güncellenir.
--
-- `post_bot_message(p_username, p_content, p_fake_likes)`:
--   Bot personası adına forum gönderisi (sahte beğeni sayısıyla).
--   Yazar-sistem tetikleyicisi admin rozeti basmasın diye rozet
--   bilerek 'none'a çekilir (test verisi dürüstlüğü).
-- `execute_bot_trade(p_symbol, p_trade_type, p_usdt_amount)`:
--   USDT cinsinden balina hamlesi — kullanıcı bakiyesine DOKUNMAZ,
--   yalnızca havuzu oynatır (rezerv + fiyat + hacim + 1m mumu).
--   - buy:  p_usdt_amount havuza girer, token çıkar.
--   - sell: p_usdt_amount havuzdan çıkar (gerekli token otomatik hesaplanır).
--
-- Her iki fonksiyon da `is_admin()` zorlar (süper admin dışı reddedilir).
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- Bot forum mesajı
-- ------------------------------------------------------------
create or replace function public.post_bot_message(
  p_username   text,
  p_content    text,
  p_fake_likes integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin bot çalıştırabilir';
  end if;

  if coalesce(trim(p_username), '') = '' then
    raise exception 'geçersiz bot adı';
  end if;
  if coalesce(trim(p_content), '') = '' then
    raise exception 'geçersiz mesaj';
  end if;
  if char_length(p_content) > 500 then
    raise exception 'mesaj en fazla 500 karakter olabilir';
  end if;

  insert into public.forum_posts (user_id, username, content, like_count)
  values (v_uid, trim(p_username), trim(p_content), greatest(coalesce(p_fake_likes, 0), 0))
  returning id into v_id;

  -- Yazar tetikleyicisi admin rozeti basmış olabilir; bot mesajları
  -- rozetsiz kalır (doğal kullanıcı görünümü).
  update public.forum_posts
    set verified_tier = 'none',
        is_verified = false
    where id = v_id;

  return v_id;
end;
$$;

revoke all on function public.post_bot_message(text, text, integer) from public;
grant execute on function public.post_bot_message(text, text, integer) to authenticated;

-- ------------------------------------------------------------
-- Bot havuz hamlesi (USDT cinsinden, bakiyesiz sistem likiditesi)
-- ------------------------------------------------------------
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
    -- Hedef USDT çıkışına ulaşan token girişi (ücret dahil) tersine çözülür.
    if p_usdt_amount >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_token_in  := ((v_k / (v_rusdt - p_usdt_amount)) - v_rtoken) / (1 - v_fee_rate);
    if v_token_in <= 0 then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken + v_token_in * (1 - v_fee_rate);
    v_new_rusdt := v_rusdt - p_usdt_amount;
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
