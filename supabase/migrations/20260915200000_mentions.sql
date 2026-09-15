-- ============================================================
-- DenizTradeX — Forum etiketleme (@kullanıcı) bildirimleri
--
-- `notifications`: bahsedilen kullanıcıya düşen "X senden bahsetti"
-- kayıtları. Yazılar:
--   - SADECE `notify_mention` RPC'siyle oluşturulur (SECURITY DEFINER;
--     kullanıcı adı → id çözümlemesi sunucuda yapılır, kendi kendini
--     etiketleme ve bilinmeyen adlar sessizce atlanır),
--   - sahibi tarafından okunur/okundu işaretlenir,
--   - yazı silinirse bildirimi durur (post_id SET NULL, alıntı korunur).
--
-- Doğrudan INSERT politikası bilerek YOKTUR (spam koruması).
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  type           text not null default 'mention' check (type in ('mention')),
  actor_username text not null default '',
  post_id        uuid references public.forum_posts (id) on delete set null,
  reply_id       uuid,
  excerpt        text not null default '',
  is_read        boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where is_read = false;

alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
  on public.notifications for select
  using (auth.uid() = user_id);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own
  on public.notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, update on public.notifications to authenticated;

-- ------------------------------------------------------------
-- notify_mention: gönderi/yanıt yayınlanınca istemci, metindeki her
-- farklı kullanıcı adı için bir kez çağırır. Sunucu:
--  1) arayanı auth.uid()'den bulur (istemciye güvenmez),
--  2) hedefi büyük-küçük harf duyarsız çözer,
--  3) kendi kendini ve bilinmeyen adları atlar,
--  4) alıntıyı 120 karakterde kırparak kaydı yazar.
-- ------------------------------------------------------------
create or replace function public.notify_mention(
  p_username text,
  p_post_id  uuid,
  p_reply_id uuid default null,
  p_excerpt  text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor    text := '';
  v_target   uuid;
begin
  if v_actor_id is null then
    return;
  end if;
  if p_username is null or btrim(p_username) = '' then
    return;
  end if;

  select p.username into v_actor
  from public.profiles as p
  where p.id = v_actor_id;

  select p.id into v_target
  from public.profiles as p
  where lower(p.username) = lower(btrim(p_username))
  limit 1;

  if v_target is null or v_target = v_actor_id then
    return;
  end if;

  insert into public.notifications (user_id, type, actor_username, post_id, reply_id, excerpt)
  values (v_target, 'mention', coalesce(nullif(v_actor, ''), 'biri'), p_post_id, p_reply_id, left(coalesce(p_excerpt, ''), 120));
end;
$$;

revoke all on function public.notify_mention(text, uuid, uuid, text) from public;
grant execute on function public.notify_mention(text, uuid, uuid, text) to authenticated;
