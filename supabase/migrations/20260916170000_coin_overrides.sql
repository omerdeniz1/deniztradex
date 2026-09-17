-- ============================================================
-- DenizTradeX — Tüm Coinler için Yükseltme/Düşürme + Haber
--
-- Önceki tasarım yalnızca `virtual_coins` tablosundaki 6 sanal coini
-- kapsıyordu (FK kısıtı yüzünden BTCUSDT gibi gerçek sembollere haber
-- eklenemiyor, durum değiştirilemiyordu).
--
-- Bu migration ile yönetim TÜM sembollere genellenir:
-- 1) `coin_overrides`: HERHANGİ bir sembol için durum
--    (normal/promoted/demoted). Sanal coin + Binance sembolleri dahil.
-- 2) `coin_news.symbol` FK'si kaldırılır (düz metin) — herhangi bir
--    sembole haber eklenebilir. Mevcut haberler korunur.
-- 3) `admin_update_coin` güncellenir: sanal coinde hem havuz satırı hem
--    override yazılır; sanal olmayan sembolde yalnızca override + haber.
-- 4) Mevcut sanal durumlar override tablosuna taşınır (idempotent).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 1) coin_overrides: her sembol için durum
-- ------------------------------------------------------------
create table if not exists public.coin_overrides (
  symbol     text primary key,
  status     text not null default 'normal'
    check (status in ('normal', 'promoted', 'demoted')),
  updated_at timestamptz not null default now()
);

alter table public.coin_overrides enable row level security;

-- Durumlar herkese açık vitrin (giriş yapmış herkes okur).
drop policy if exists coin_overrides_select_all on public.coin_overrides;
create policy coin_overrides_select_all
  on public.coin_overrides for select
  to authenticated
  using (true);

-- Yazım yalnızca süper admin.
drop policy if exists coin_overrides_write_admin on public.coin_overrides;
create policy coin_overrides_write_admin
  on public.coin_overrides for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- set_updated_at altcoin_admin migration'ında tanımlıdır; tek başına
-- uygulanırsa diye burada da güvenceye alınır (aynı tanım, idempotent).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;

drop trigger if exists coin_overrides_updated_at on public.coin_overrides;
create trigger coin_overrides_updated_at
  before update on public.coin_overrides
  for each row execute function public.set_updated_at();

-- Mevcut sanal durumları taşı (normal dışı olanlar; normal zaten varsayılan).
insert into public.coin_overrides (symbol, status)
select symbol, status
  from public.virtual_coins
  where status is distinct from 'normal'
on conflict (symbol)
do update set
  status = excluded.status,
  updated_at = now();

-- ------------------------------------------------------------
-- 2) coin_news.symbol: FK'yi kaldır, düz metin yap
-- ------------------------------------------------------------
do $$
declare
  v_con text;
begin
  if to_regclass('public.coin_news') is null then
    return;
  end if;
  select conname into v_con
    from pg_constraint
    where conrelid = 'public.coin_news'::regclass
      and contype = 'f'
  limit 1;
  if v_con is not null then
    execute format('alter table public.coin_news drop constraint %I', v_con);
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 3) admin_update_coin: TÜM semboller
-- ------------------------------------------------------------
create or replace function public.admin_update_coin(
  p_symbol     text,
  p_status     text default null,
  p_news_title text default null,
  p_news_body  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol text := upper(trim(coalesce(p_symbol, '')));
  v_status text;
  v_is_virtual boolean;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin coin yönetebilir';
  end if;

  if v_symbol = '' then
    raise exception 'geçersiz coin sembolü';
  end if;

  select true into v_is_virtual
    from public.virtual_coins
    where symbol = v_symbol;
  v_is_virtual := coalesce(v_is_virtual, false);

  -- Durum güncelleme (tüm semboller override tablosuna yazılır).
  if p_status is not null then
    if p_status not in ('normal', 'promoted', 'demoted') then
      raise exception 'geçersiz durum: normal, promoted, demoted olmalı';
    end if;
    insert into public.coin_overrides (symbol, status)
    values (v_symbol, p_status)
    on conflict (symbol)
    do update set
      status = excluded.status,
      updated_at = now();
    -- Sanal coinde havuz satırı da senkron tutulur (eski okuyucular için).
    if v_is_virtual then
      update public.virtual_coins
        set status = p_status
        where symbol = v_symbol;
    end if;
  end if;

  -- Haber ekleme (tüm semboller).
  if p_news_title is not null and p_news_body is not null then
    if char_length(trim(p_news_title)) = 0 or char_length(trim(p_news_body)) = 0 then
      raise exception 'haber başlığı ve metni gerekli';
    end if;
    if char_length(trim(p_news_title)) > 200 then
      raise exception 'haber başlığı en fazla 200 karakter olabilir';
    end if;
    if char_length(trim(p_news_body)) > 2000 then
      raise exception 'haber metni en fazla 2000 karakter olabilir';
    end if;
    insert into public.coin_news (symbol, title, body, created_by)
    values (v_symbol, trim(p_news_title), trim(p_news_body), auth.uid());
  end if;

  select coalesce(
    (select status from public.coin_overrides where symbol = v_symbol),
    (select status from public.virtual_coins where symbol = v_symbol),
    'normal'
  ) into v_status;

  return jsonb_build_object(
    'ok', true,
    'symbol', v_symbol,
    'status', v_status,
    'news', (
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'title', title,
        'body', body,
        'created_at', created_at
      ) order by created_at desc)
      from public.coin_news
      where symbol = v_symbol
      limit 20
    )
  );
end;
$$;

revoke all on function public.admin_update_coin(text, text, text, text) from public;
grant execute on function public.admin_update_coin(text, text, text, text) to authenticated;
