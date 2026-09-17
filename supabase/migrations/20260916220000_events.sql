-- ============================================================
-- DenizTradeX — Etkinlikler (Events)
--
-- `events`: admin tarafından girilen platform etkinlikleri/duyuruları
-- (yarışma, ödüllü işlem haftası vb.). Menüdeki "Etkinlik" sekmesinde
-- listelenir; kayıt yoksa istemci "aktif etkinlik yok" gösterir.
-- Yazım YALNIZCA süper admin (RPC + RLS çift kapı).
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 120),
  body        text not null check (char_length(body) between 1 and 2000),
  starts_at   timestamptz,
  ends_at     timestamptz,
  is_active   boolean not null default true,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists events_active_idx
  on public.events (is_active, created_at desc);

alter table public.events enable row level security;

-- Herkes okur (giriş yapmış kullanıcılar).
drop policy if exists events_select_all on public.events;
create policy events_select_all
  on public.events for select
  to authenticated
  using (true);

-- Doğrudan yazım kapalı; yalnız RPC yazar.
drop policy if exists events_no_direct_write on public.events;
create policy events_no_direct_write
  on public.events for all
  to authenticated
  using (false)
  with check (false);

drop trigger if exists events_updated_at on public.events;
create trigger events_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- upsert_event: etkinlik ekle/güncelle (süper admin)
-- ------------------------------------------------------------
create or replace function public.upsert_event(
  p_id        uuid default null,
  p_title     text default null,
  p_body      text default null,
  p_starts_at timestamptz default null,
  p_ends_at   timestamptz default null,
  p_is_active boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin etkinlik düzenleyebilir';
  end if;

  if p_id is null then
    if coalesce(trim(p_title), '') = '' then
      raise exception 'etkinlik başlığı gerekli';
    end if;
    if coalesce(trim(p_body), '') = '' then
      raise exception 'etkinlik metni gerekli';
    end if;
    if char_length(trim(p_title)) > 120 then
      raise exception 'başlık en fazla 120 karakter olabilir';
    end if;
    if char_length(trim(p_body)) > 2000 then
      raise exception 'metin en fazla 2000 karakter olabilir';
    end if;
    if p_ends_at is not null and p_starts_at is not null and p_ends_at <= p_starts_at then
      raise exception 'bitiş tarihi başlangıçtan sonra olmalı';
    end if;
    insert into public.events (title, body, starts_at, ends_at, is_active, created_by)
    values (
      trim(p_title), trim(p_body), p_starts_at, p_ends_at,
      coalesce(p_is_active, true), auth.uid()
    )
    returning id into v_id;
  else
    update public.events
      set title     = coalesce(trim(p_title), title),
          body      = coalesce(trim(p_body), body),
          starts_at = coalesce(p_starts_at, starts_at),
          ends_at   = coalesce(p_ends_at, ends_at),
          is_active = coalesce(p_is_active, is_active)
      where id = p_id
      returning id into v_id;
    if not found then
      raise exception 'etkinlik bulunamadı';
    end if;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.upsert_event(uuid, text, text, timestamptz, timestamptz, boolean) from public;
grant execute on function public.upsert_event(uuid, text, text, timestamptz, timestamptz, boolean) to authenticated;

-- ------------------------------------------------------------
-- delete_event: etkinlik sil (süper admin)
-- ------------------------------------------------------------
create or replace function public.delete_event(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin etkinlik silebilir';
  end if;
  delete from public.events where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_event(uuid) from public;
grant execute on function public.delete_event(uuid) to authenticated;
