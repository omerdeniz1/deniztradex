-- ============================================================
-- DenizTradeX — DNZ borsa tokenı (BNB benzeri)
--
-- Token ekonomisi (istemcide de sabit: `DNZ_TOTAL_SUPPLY`):
--  - Toplam arz: 200.000.000 DNZ (sabit, basım yok).
--  - Komisyon indirimi: komisyonu DNZ ile ödeyene %25 indirim
--    (istemci `DNZ_FEE_DISCOUNT`, ücret `engine/fees.ts`).
--  - Fiyat: simüle edilir (istemci deterministik yürüyüş
--    `dnzService`; sunucu yalnızca bakiye/defter tutar).
--
-- 1) `dnz_balances`: hesap başına DNZ bakiyesi (tek satır).
-- 2) `dnz_ledger`: tüm DNZ hareketleri (alım/satım/komisyon/
--    indirim/transfer/airdrop) — denetim defteri.
-- 3) `transactions.type`: `fee` tipi eklenir (komisyonun USDT
--    bacağı bu deftere yazılır; DNZ bacağı `dnz_ledger`'a).
-- 4) `transfer_dnz`: satır kilitli hesaplar-arası DNZ transferi
--    (iki tarafa defter + `transactions` satırı).
--
-- Gereksinim: 20260918130000_wallet_transfer (`profiles.wallet_no`).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Bakiye tablosu
-- ------------------------------------------------------------
create table if not exists public.dnz_balances (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    numeric(30,8) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) İşlem defteri
-- ------------------------------------------------------------
create table if not exists public.dnz_ledger (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  type          text not null check (
                  type in ('buy','sell','fee','fee_discount','transfer_in','transfer_out','airdrop')
                ),
  amount_dnz    numeric(30,8) not null,
  price_usdt    numeric(20,8),
  amount_usdt   numeric(20,8),
  balance_after numeric(30,8),
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists dnz_ledger_user_created_idx
  on public.dnz_ledger (user_id, created_at desc);

alter table public.dnz_balances enable row level security;
alter table public.dnz_ledger   enable row level security;

-- ------------------------------------------------------------
-- 3) RLS: kendi satırları (profil deseniyle birebir).
-- ------------------------------------------------------------
drop policy if exists dnz_balances_select_own on public.dnz_balances;
create policy dnz_balances_select_own
  on public.dnz_balances for select
  using (auth.uid() = user_id);

drop policy if exists dnz_balances_insert_own on public.dnz_balances;
create policy dnz_balances_insert_own
  on public.dnz_balances for insert
  with check (auth.uid() = user_id);

drop policy if exists dnz_balances_update_own on public.dnz_balances;
create policy dnz_balances_update_own
  on public.dnz_balances for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists dnz_ledger_select_own on public.dnz_ledger;
create policy dnz_ledger_select_own
  on public.dnz_ledger for select
  using (auth.uid() = user_id);

drop policy if exists dnz_ledger_insert_own on public.dnz_ledger;
create policy dnz_ledger_insert_own
  on public.dnz_ledger for insert
  with check (auth.uid() = user_id);

grant select, insert, update on public.dnz_balances to authenticated;
grant select, insert on public.dnz_ledger to authenticated;

-- ------------------------------------------------------------
-- 4) `transactions` komisyon tipi (`fee`).
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
-- 5) Hesaplar arası DNZ transferi (satır kilitli, çift defterli).
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
  v_bal      numeric;
begin
  if v_sender is null then
    raise exception 'giriş gerekli';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'geçersiz tutar';
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

  select balance into v_bal
  from public.dnz_balances
  where user_id = v_sender
  for update;
  if coalesce(v_bal, 0) < v_qty then
    raise exception 'yetersiz DNZ bakiyesi';
  end if;

  update public.dnz_balances
  set balance = balance - v_qty, updated_at = now()
  where user_id = v_sender;

  insert into public.dnz_balances (user_id, balance)
  values (v_receiver, v_qty)
  on conflict (user_id)
  do update set balance = public.dnz_balances.balance + excluded.balance,
                updated_at = now();

  insert into public.dnz_ledger (user_id, type, amount_dnz, balance_after)
  values
    (v_sender, 'transfer_out', v_qty, coalesce(v_bal, 0) - v_qty),
    (v_receiver, 'transfer_in', v_qty,
      (select balance from public.dnz_balances where user_id = v_receiver));

  insert into public.transactions (user_id, type, symbol, side, quantity)
  values (v_sender, 'transfer_out', 'DNZ', 'sell', v_qty),
         (v_receiver, 'transfer_in', 'DNZ', 'buy', v_qty);

  return jsonb_build_object('ok', true, 'asset', 'DNZ', 'amount', v_qty);
end;
$$;

revoke all on function public.transfer_dnz(text, numeric) from public;
grant execute on function public.transfer_dnz(text, numeric) to authenticated;
