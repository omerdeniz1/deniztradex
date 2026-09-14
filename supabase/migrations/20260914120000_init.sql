-- ============================================================
-- DenizTradeX — Supabase schema (initial migration)
-- Run this in the SQL Editor or via `supabase db push`.
-- ============================================================

-- ------------------------------------------------------------
-- profiles: one row per auth.users account. Balance is the
-- source of truth for the wallet (default 10,000 USDT).
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  email      text not null,
  full_name  text,
  avatar_url text,
  balance    numeric(20,4) not null default 10000.00,
  created_at timestamptz   not null default now(),
  constraint profiles_username_key unique (username)
);

-- ------------------------------------------------------------
-- Automated initial balance: a new sign-up automatically gets a
-- profiles row seeded with the default 10,000 USDT balance.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, email, balance)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    coalesce(new.email, ''),
    10000.00
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- transactions: balance ledger — buy/sell fills, withdrawals,
-- promo / referral bonus credits.
-- ------------------------------------------------------------
create table if not exists public.transactions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  type          text not null check (
                  type in ('trade_buy','trade_sell','withdraw','promo','referral')
                ),
  symbol        text,
  side          text check (side in ('buy','sell')),
  quantity      numeric(20,8),
  price         numeric(20,8),
  amount_usdt   numeric(20,8),
  balance_after numeric(20,4),
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists transactions_user_id_created_at_idx
  on public.transactions (user_id, created_at desc);

-- ------------------------------------------------------------
-- deposit_history: card deposits plus promo / referral funded
-- amounts (source column keeps them apart).
-- ------------------------------------------------------------
create table if not exists public.deposit_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  amount_usdt numeric(20,8) not null,
  amount_try  numeric(20,2),
  rate        numeric(20,6),
  method      text not null default 'card',
  source      text not null default 'card' check (source in ('card','promo','referral')),
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists deposit_history_user_id_created_at_idx
  on public.deposit_history (user_id, created_at desc);

-- ------------------------------------------------------------
-- Row Level Security: demo trading simulation — users manage
-- their own rows. The profile update policy lets the wallet
-- sync the balance from the client (suitable for the simulator;
-- gate it behind an RPC for a hardened production setup).
-- ------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.transactions    enable row level security;
alter table public.deposit_history enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own
  on public.transactions for select
  using (auth.uid() = user_id);

drop policy if exists transactions_insert_own on public.transactions;
create policy transactions_insert_own
  on public.transactions for insert
  with check (auth.uid() = user_id);

drop policy if exists deposit_history_select_own on public.deposit_history;
create policy deposit_history_select_own
  on public.deposit_history for select
  using (auth.uid() = user_id);

drop policy if exists deposit_history_insert_own on public.deposit_history;
create policy deposit_history_insert_own
  on public.deposit_history for insert
  with check (auth.uid() = user_id);