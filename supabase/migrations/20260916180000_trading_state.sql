-- ============================================================
-- DenizTradeX — Cihazlar Arası İşlem Senkronu
--
-- Sorun: açık pozisyonlar / spot bakiyeler / bekleyen emirler yalnızca
-- cihazın localStorage'ında (mobilde açılan işlem masaüstünde görünmez).
-- Bakiye zaten `profiles.balance` üzerinden senkrondu; bu tablo geri
-- kalan işlem durumunu sunucuya taşır.
--
-- `trading_state`: kullanıcı başına tek satır (user_id PK).
--   - positions / spot_balances / spot_positions / pending_orders /
--     trades / spot_trades: JSONB anlık görüntüler.
--   - updated_at: son yazan cihazın zamanı (çatışmada son yazan kazanır).
--
-- RLS: satır yalnızca sahibine görünür/yazılır.
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.trading_state (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  positions      jsonb not null default '[]'::jsonb,
  spot_balances  jsonb not null default '{}'::jsonb,
  spot_positions jsonb not null default '[]'::jsonb,
  pending_orders jsonb not null default '[]'::jsonb,
  trades         jsonb not null default '[]'::jsonb,
  spot_trades    jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

alter table public.trading_state enable row level security;

drop policy if exists trading_state_select_own on public.trading_state;
create policy trading_state_select_own
  on public.trading_state for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists trading_state_insert_own on public.trading_state;
create policy trading_state_insert_own
  on public.trading_state for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists trading_state_update_own on public.trading_state;
create policy trading_state_update_own
  on public.trading_state for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists trading_state_delete_own on public.trading_state;
create policy trading_state_delete_own
  on public.trading_state for delete
  to authenticated
  using (auth.uid() = user_id);
