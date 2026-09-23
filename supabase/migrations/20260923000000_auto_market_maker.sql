-- ============================================================
-- DenizTradeX — Otomatik Piyasa Botları (arka plan market-maker)
--
-- Amaç: sanal coinler 7/24 kendi kendine oynasın — fiyat dalgalansın,
-- `volume_24h` büyüsün, grafik canlı kalsın. İstemci (`useAutoMarketMaker`)
-- her ~12 sn'de küçük bir hamle tetikler; AĞIRLIK sunucudadır:
--
-- `execute_auto_market_trade(p_symbol, p_trade_type, p_usdt_amount)`:
--   - Admin ZORUNLU DEĞİLDİR (her giriş yapmış istemci çağırabilir —
--     motor herkeste çalışır, tek bir admin sekmesine bağımlı değildir).
--   - Hamle SUNUCUDA sert sınırlanır: istenen tutar havuz USDT
--     rezervinin BİNDE 2'sini (ve 25.000 USDT'yi) aşamaz; aşan kısım
--     sessizce kırpılır. İstemci ne gönderirse göndersin havuz
--     boşaltılamaz, fiyat tek tikte uçamaz.
--   - Kullanıcı bakiyesine DOKUNMAZ, foruma yazmaz; yalnızca rezerv +
--     fiyat + hacim + 1m mumu günceller (gerçek takasla aynı kural).
--
-- `auto_bot_config` (id=1): motor anahtarı — tüm istemciler okur,
--   yalnızca süper admin `update_auto_bot_config` RPC'si ile yazar.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Oto-bot yapılandırması (tek satır)
-- ------------------------------------------------------------
create table if not exists public.auto_bot_config (
  id           integer primary key default 1 check (id = 1),
  enabled      boolean not null default true,
  interval_sec integer not null default 12
    check (interval_sec >= 4 and interval_sec <= 300),
  intensity    text not null default 'normal'
    check (intensity in ('calm', 'normal', 'lively')),
  updated_at   timestamptz not null default now()
);

alter table public.auto_bot_config enable row level security;

-- Motor ayarı herkese açık vitrin (giriş yapmış her istemci okur).
drop policy if exists auto_bot_config_select_all on public.auto_bot_config;
create policy auto_bot_config_select_all
  on public.auto_bot_config for select
  to authenticated
  using (true);

-- Doğrudan yazım kapalı; yalnız RPC (aşağıda) yazar.
drop policy if exists auto_bot_config_no_direct_write on public.auto_bot_config;
create policy auto_bot_config_no_direct_write
  on public.auto_bot_config for all
  to authenticated
  using (false)
  with check (false);

insert into public.auto_bot_config (id)
values (1)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2) update_auto_bot_config: motor ayarını değiştir (süper admin)
-- ------------------------------------------------------------
create or replace function public.update_auto_bot_config(
  p_enabled      boolean default null,
  p_interval_sec integer default null,
  p_intensity    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin oto-bot ayarını değiştirebilir';
  end if;

  if p_interval_sec is not null
     and (p_interval_sec < 4 or p_interval_sec > 300) then
    raise exception 'geçersiz aralık (4-300 sn olmalı)';
  end if;

  if p_intensity is not null
     and p_intensity not in ('calm', 'normal', 'lively') then
    raise exception 'geçersiz yoğunluk';
  end if;

  update public.auto_bot_config
    set enabled      = coalesce(p_enabled, enabled),
        interval_sec = coalesce(p_interval_sec, interval_sec),
        intensity    = coalesce(p_intensity, intensity),
        updated_at   = now()
    where id = 1;

  return jsonb_build_object(
    'ok', true,
    'config', (
      select to_jsonb(public.auto_bot_config)
        from public.auto_bot_config
        where id = 1
    )
  );
end;
$$;

revoke all on function public.update_auto_bot_config(boolean, integer, text) from public;
grant execute on function public.update_auto_bot_config(boolean, integer, text) to authenticated;

-- ------------------------------------------------------------
-- 3) execute_auto_market_trade: limitli oto-bot hamlesi
--    (admin ŞART DEĞİL — sunucu cap'i güvenliği sağlar)
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
  -- Güvenlik cap'leri: hamle başına havuzun binde 2'si, en fazla 25000 USDT.
  v_cap_frac   constant numeric := 0.002;
  v_cap_abs    constant numeric := 25000;
  v_amount     numeric;
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
    if v_amount >= v_rusdt then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_token_in  := ((v_k / (v_rusdt - v_amount)) - v_rtoken) / (1 - v_fee_rate);
    if v_token_in <= 0 then
      raise exception 'havuz derinliği yetersiz';
    end if;
    v_new_rtoken := v_rtoken + v_token_in * (1 - v_fee_rate);
    v_new_rusdt := v_rusdt - v_amount;
    v_token_out := v_token_in;
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
    'token_amount', v_token_out,
    'usdt_amount', v_amount,
    'price', v_old_price,
    'new_price', v_new_price,
    'price_impact_pct', ((v_new_price - v_old_price) / v_old_price) * 100
  );
end;
$$;

revoke all on function public.execute_auto_market_trade(text, text, numeric) from public;
grant execute on function public.execute_auto_market_trade(text, text, numeric) to authenticated;
