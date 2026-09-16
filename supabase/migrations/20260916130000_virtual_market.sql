-- ============================================================
-- DenizTradeX — Sanal Piyasa (AMM x*y=k, iç ekosistem)
--
-- `virtual_coins`: likidite havuzları (rezervler + anlık fiyat).
-- `virtual_holdings`: kullanıcıların sanal coin bakiyeleri (satış
--   tarafı bütünlüğü için şart — havuzdan çıkan token cüzdana işlenir).
-- `execute_virtual_trade`: %0.3 ücretli AMM takası (SECURITY DEFINER).
--   - buy:  p_amount = yatırılan USDT → token çıkar, USDT bakiyesi düşer
--   - sell: p_amount = satılan token → USDT çıkar, USDT bakiyesi artar
--   Başarıda havuz rezervleri, current_price ve volume_24h güncellenir.
--
-- RLS: havuzlar herkese açık okunur; yazım YALNIZCA RPC üzerinden
-- (kullanıcı kendi adına işlem yapar: p_user_id = auth.uid()).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.virtual_coins (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null unique,
  name          text not null,
  type          text not null check (type in ('crypto', 'commodity')),
  reserve_usdt  numeric not null check (reserve_usdt > 0),
  reserve_token numeric not null check (reserve_token > 0),
  current_price numeric not null check (current_price > 0),
  volume_24h    numeric not null default 0
);

create table if not exists public.virtual_holdings (
  user_id  uuid not null references auth.users (id) on delete cascade,
  symbol   text not null references public.virtual_coins (symbol) on delete cascade,
  quantity numeric not null default 0 check (quantity >= 0),
  primary key (user_id, symbol)
);

create index if not exists virtual_holdings_user_idx
  on public.virtual_holdings (user_id);

alter table public.virtual_coins enable row level security;
alter table public.virtual_holdings enable row level security;

-- Havuzlar herkese açık vitrin (giriş yapmış herkes okur).
drop policy if exists virtual_coins_select_all on public.virtual_coins;
create policy virtual_coins_select_all
  on public.virtual_coins for select
  to authenticated
  using (true);

-- Cüzdan satırları yalnızca sahibine görünür.
drop policy if exists virtual_holdings_select_own on public.virtual_holdings;
create policy virtual_holdings_select_own
  on public.virtual_holdings for select
  to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Seed: hiyerarşik havuz derinlikleri (fiyat = usdt/token).
-- ------------------------------------------------------------
insert into public.virtual_coins (symbol, name, type, reserve_usdt, reserve_token, current_price)
values
  ('ENTES', 'ENTES COIN', 'crypto',    50000000,   5000000,  10),
  ('V-XAU', 'Sanal Altın', 'commodity', 30000000,    300000, 100),
  ('V-XAG', 'Sanal Gümüş', 'commodity', 20000000,   1000000,  20),
  ('RGC',   'RGCOIN',      'crypto',     1000000, 100000000,   0.01),
  ('MPRC',  'MPRCOIN',     'crypto',      800000,  26666666,   0.03),
  ('SVGC',  'SVGCOIN',     'crypto',      500000, 100000000,   0.005)
on conflict (symbol) do nothing;

-- ------------------------------------------------------------
-- execute_virtual_trade(p_user_id, p_symbol, p_trade_type, p_amount)
-- returns jsonb { ok, token_amount, usdt_amount, price, new_price,
--                 price_impact_pct }
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
