-- ============================================================
-- DenizTradeX — Altcoin Yönetimi (Admin Paneli)
--
-- virtual_coins tablosuna durum alanı (promote/demote) eklenir.
-- coin_news tablosu: coin bazlı haber/duyuru yönetimi.
-- Tüm yazımlar admin_update_coin RPC'si üzerinden (süper admin).
-- ============================================================

-- ------------------------------------------------------------
-- 1) virtual_coins: durum kolonu (promote/demote)
-- ------------------------------------------------------------
alter table public.virtual_coins
  add column if not exists status text not null default 'normal'
  check (status in ('normal', 'promoted', 'demoted'));

-- Mevcut coinler 'normal' olarak kalır (idempotent).

-- ------------------------------------------------------------
-- 2) coin_news: coin bazlı haberler
-- ------------------------------------------------------------
create table if not exists public.coin_news (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null references public.virtual_coins (symbol) on delete cascade,
  title         text not null,
  body          text not null,
  created_by    uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists coin_news_symbol_idx
  on public.coin_news (symbol);

create index if not exists coin_news_created_at_idx
  on public.coin_news (created_at desc);

alter table public.coin_news enable row level security;

-- Herkes okuyabilir (giriş yapmış kullanıcılar).
drop policy if exists coin_news_select_all on public.coin_news;
create policy coin_news_select_all
  on public.coin_news for select
  to authenticated
  using (true);

-- Yazım yalnızca süper admin (is_admin()).
drop policy if exists coin_news_insert_admin on public.coin_news;
create policy coin_news_insert_admin
  on public.coin_news for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists coin_news_update_admin on public.coin_news;
create policy coin_news_update_admin
  on public.coin_news for update
  to authenticated
  with check (public.is_admin());

drop policy if exists coin_news_delete_admin on public.coin_news;
create policy coin_news_delete_admin
  on public.coin_news for delete
  to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- 3) updated_at tetikleyicisi (coin_news)
-- ------------------------------------------------------------
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

drop trigger if exists coin_news_updated_at on public.coin_news;
create trigger coin_news_updated_at
  before update on public.coin_news
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 4) admin_update_coin: coin durumu ve haber yönetimi (süper admin)
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
  v_exists boolean;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin coin yönetebilir';
  end if;

  if coalesce(trim(p_symbol), '') = '' then
    raise exception 'geçersiz coin sembolü';
  end if;

  -- Coin var mı?
  select true into v_exists
    from public.virtual_coins
    where symbol = p_symbol;
  if not found then
    raise exception 'coin bulunamadı: %', p_symbol;
  end if;

  -- Durum güncelleme
  if p_status is not null then
    if p_status not in ('normal', 'promoted', 'demoted') then
      raise exception 'geçersiz durum: normal, promoted, demoted olmalı';
    end if;
    update public.virtual_coins
      set status = p_status
      where symbol = p_symbol;
  end if;

  -- Haber ekleme
  if p_news_title is not null and p_news_body is not null then
    if char_length(trim(p_news_title)) > 200 then
      raise exception 'haber başlığı en fazla 200 karakter olabilir';
    end if;
    if char_length(trim(p_news_body)) > 2000 then
      raise exception 'haber metni en fazla 2000 karakter olabilir';
    end if;
    insert into public.coin_news (symbol, title, body, created_by)
    values (p_symbol, trim(p_news_title), trim(p_news_body), auth.uid());
  end if;

  -- Güncel coin + haberleri döndür
  return jsonb_build_object(
    'ok', true,
    'symbol', p_symbol,
    'status', (select status from public.virtual_coins where symbol = p_symbol),
    'news', (
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'title', title,
        'body', body,
        'created_at', created_at
      ) order by created_at desc)
      from public.coin_news
      where symbol = p_symbol
      limit 20
    )
  );
end;
$$;

revoke all on function public.admin_update_coin(text, text, text, text) from public;
grant execute on function public.admin_update_coin(text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 5) admin_delete_coin_news: haber silme (süper admin)
-- ------------------------------------------------------------
create or replace function public.admin_delete_coin_news(
  p_news_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin haber silebilir';
  end if;

  delete from public.coin_news
    where id = p_news_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_delete_coin_news(uuid) from public;
grant execute on function public.admin_delete_coin_news(uuid) to authenticated;