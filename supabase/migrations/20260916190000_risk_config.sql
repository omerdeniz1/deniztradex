-- ============================================================
-- DenizTradeX — Risk Yapılandırması (adil likidasyon)
--
-- Sorun: likidasyon eşikleri koda gömülüydü; bakım marjini kavramı yoktu
-- ve ham tik fiyatı tek bir fitilde pozisyon patlatıyordu.
--
-- Bu migration risk parametrelerini veritabanına taşır (Binance Futures
-- mantığı: düşük bakım marjini + mark-price + kademeli uyarı):
--   - `risk_config`: tek satırlık (id=1) yapılandırma tablosu.
--   - `maintenance_margin_rate`: likidasyon fiyatındaki bakım payı
--     (varsayılan %0.4 — Binance en düşük kademesi).
--   - `margin_call_warn_loss_frac` / `margin_call_critical_loss_frac`:
--     teminatın uyarı (%50) ve kritik (%80) tüketim eşikleri.
--   - `liq_confirm_ticks`: likidasyonun kaç ardışık fiyat kontrolü
--     ihlalden sonra işletileceği (tek fitil patlatmaz).
--   - `mark_price_window`: mark-price medyan pencere genişliği.
--   - `bot_max_pool_fraction`: bot hamlesinin havuz rezervine oranı
--     üst sınırı (sığ havuzda devasa kayma engeli).
-- Yazım `update_risk_config` RPC'sinden geçer (yalnızca süper admin);
-- okuma tüm giriş yapmış kullanıcılara açıktır.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.risk_config (
  id                            integer primary key default 1 check (id = 1),
  maintenance_margin_rate       numeric not null default 0.004
    check (maintenance_margin_rate >= 0 and maintenance_margin_rate <= 0.1),
  margin_call_warn_loss_frac    numeric not null default 0.5
    check (margin_call_warn_loss_frac > 0 and margin_call_warn_loss_frac < 1),
  margin_call_critical_loss_frac numeric not null default 0.8
    check (margin_call_critical_loss_frac > 0 and margin_call_critical_loss_frac < 1),
  liq_confirm_ticks             integer not null default 3
    check (liq_confirm_ticks >= 1 and liq_confirm_ticks <= 20),
  mark_price_window             integer not null default 5
    check (mark_price_window >= 1 and mark_price_window <= 50),
  bot_max_pool_fraction         numeric not null default 0.02
    check (bot_max_pool_fraction > 0 and bot_max_pool_fraction <= 0.2),
  updated_at                    timestamptz not null default now()
);

alter table public.risk_config enable row level security;

-- Parametreler herkese açık vitrin (giriş yapmış herkes okur).
drop policy if exists risk_config_select_all on public.risk_config;
create policy risk_config_select_all
  on public.risk_config for select
  to authenticated
  using (true);

-- Doğrudan yazım kapalı; yalnız RPC (aşağıda) yazar.
drop policy if exists risk_config_no_direct_write on public.risk_config;
create policy risk_config_no_direct_write
  on public.risk_config for all
  to authenticated
  using (false)
  with check (false);

-- Varsayılan satırı tohumla (idempotent).
insert into public.risk_config (id)
values (1)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- update_risk_config: risk parametrelerini günceller (süper admin)
-- ------------------------------------------------------------
create or replace function public.update_risk_config(
  p_maintenance_margin_rate        numeric default null,
  p_margin_call_warn_loss_frac     numeric default null,
  p_margin_call_critical_loss_frac numeric default null,
  p_liq_confirm_ticks              integer default null,
  p_mark_price_window              integer default null,
  p_bot_max_pool_fraction          numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin risk ayarını değiştirebilir';
  end if;

  if p_margin_call_warn_loss_frac is not null
     and p_margin_call_critical_loss_frac is not null
     and p_margin_call_warn_loss_frac >= p_margin_call_critical_loss_frac then
    raise exception 'uyarı eşiği kritik eşikten küçük olmalı';
  end if;

  update public.risk_config
    set maintenance_margin_rate        = coalesce(p_maintenance_margin_rate, maintenance_margin_rate),
        margin_call_warn_loss_frac     = coalesce(p_margin_call_warn_loss_frac, margin_call_warn_loss_frac),
        margin_call_critical_loss_frac = coalesce(p_margin_call_critical_loss_frac, margin_call_critical_loss_frac),
        liq_confirm_ticks              = coalesce(p_liq_confirm_ticks, liq_confirm_ticks),
        mark_price_window              = coalesce(p_mark_price_window, mark_price_window),
        bot_max_pool_fraction          = coalesce(p_bot_max_pool_fraction, bot_max_pool_fraction),
        updated_at                     = now()
    where id = 1;

  return jsonb_build_object(
    'ok', true,
    'config', (
      select to_jsonb(public.risk_config)
        from public.risk_config
        where id = 1
    )
  );
end;
$$;

revoke all on function public.update_risk_config(numeric, numeric, numeric, integer, integer, numeric) from public;
grant execute on function public.update_risk_config(numeric, numeric, numeric, integer, integer, numeric) to authenticated;
