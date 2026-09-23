-- ============================================================
-- DenizTradeX — Oto-bot sunucu görevi (sıfır ziyaretçide bile çalışır)
--
-- İstemci motoru (`useAutoMarketMaker`) yalnızca site açıkken tik atar.
-- Bu dosya hareketi sunucuya taşır: `pg_cron` her dakika
-- `run_auto_market_bot()` çalıştırır — gece 04:00'te kimse sitede
-- yokken bile sanal coinler oynar, hacim büyür, mumlar işlenir.
--
-- `run_auto_market_bot()`:
--   - `auto_bot_config` kapalıysa hiçbir şey yapmaz (admin panelindeki
--     aç/kapat sunucu görevini de yönetir; yoğunluk tur sayısını belirler:
--     calm 2, normal 4, lively 6 hamle/dakika).
--   - Her hamlede rastgele coin + rastgele yön; fiyat çapadan (anchor)
--     %8'den fazla saparsa %75 olasılıkla ters yöne basar — coin tek
--     yöne kaçmaz. Yeni coinler çapaya otomatik kaydedilir (DNZ dahil
--     tüm `virtual_coins` satırları kapsanır).
--   - Tutar havuzun binde 3'ünü ve 25.000 USDT'yi aşamaz; bakiyeye
--     dokunulmaz, foruma yazılmaz. Hacim + 1m mumu gerçek takasla
--     aynı kuralda güncellenir.
--
-- NOT: `pg_cron` Supabase'te Dashboard → Database → Extensions altından
-- açık olmalı; kapalıysa aşağıdaki CREATE EXTENSION satırı hata verir —
-- önce eklentiyi açıp scripti tekrar çalıştırın.
--
-- Idempotent: tekrar çalıştırılabilir (zamanlama tek job olarak yenilenir).
-- ============================================================

create extension if not exists pg_cron;

-- ------------------------------------------------------------
-- 1) Çapa tablosu: her coinin dönüş hedefi (ortalama-dönüş bandı)
-- ------------------------------------------------------------
create table if not exists public.auto_bot_anchor (
  symbol       text primary key references public.virtual_coins (symbol) on delete cascade,
  anchor_price numeric not null check (anchor_price > 0),
  updated_at   timestamptz not null default now()
);

alter table public.auto_bot_anchor enable row level security;

drop policy if exists auto_bot_anchor_select_all on public.auto_bot_anchor;
create policy auto_bot_anchor_select_all
  on public.auto_bot_anchor for select
  to authenticated
  using (true);

drop policy if exists auto_bot_anchor_no_direct_write on public.auto_bot_anchor;
create policy auto_bot_anchor_no_direct_write
  on public.auto_bot_anchor for all
  to authenticated
  using (false)
  with check (false);

-- Mevcut havuzları çapala (yeniler fonksiyonda otomatik eklenir).
insert into public.auto_bot_anchor (symbol, anchor_price)
select symbol, current_price from public.virtual_coins
on conflict (symbol) do nothing;

-- ------------------------------------------------------------
-- 2) Dakikalık sunucu turu
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
      if v_amount >= v_rusdt then
        continue;
      end if;
      v_token_in := ((v_k / (v_rusdt - v_amount)) - v_rtoken) / (1 - v_fee_rate);
      if v_token_in is null or v_token_in <= 0 then
        continue;
      end if;
      v_new_rtoken := v_rtoken + v_token_in * (1 - v_fee_rate);
      v_new_rusdt := v_rusdt - v_amount;
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

-- ------------------------------------------------------------
-- 3) Zamanlama: her dakika tek job (idempotent yenileme)
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'auto-market-maker-1m') then
    perform cron.unschedule('auto-market-maker-1m');
  end if;
  perform cron.schedule(
    'auto-market-maker-1m',
    '* * * * *',
    'select public.run_auto_market_bot();'
  );
end;
$$;
