-- ============================================================
-- DenizTradeX — Forum yanıtları (replies)
--
-- `forum_replies`: gönderi altı yanıt dizisi. `reply_count`
-- tetikleyici ile `forum_posts` üzerinde tutulur.
-- ============================================================

alter table public.forum_posts
  add column if not exists reply_count integer not null default 0;

create table if not exists public.forum_replies (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.forum_posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  username   text not null,
  content    text not null check (char_length(content) between 1 and 280),
  created_at timestamptz not null default now()
);

create index if not exists forum_replies_post_id_idx
  on public.forum_replies (post_id, created_at asc);

create index if not exists forum_replies_user_id_idx
  on public.forum_replies (user_id);

alter table public.forum_replies enable row level security;

drop policy if exists forum_replies_select_all on public.forum_replies;
create policy forum_replies_select_all
  on public.forum_replies for select
  using (true);

drop policy if exists forum_replies_insert_own on public.forum_replies;
create policy forum_replies_insert_own
  on public.forum_replies for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_replies_delete_own on public.forum_replies;
create policy forum_replies_delete_own
  on public.forum_replies for delete
  using (auth.uid() = user_id);

grant select on public.forum_replies to anon, authenticated;
grant insert, delete on public.forum_replies to authenticated;

-- ------------------------------------------------------------
-- reply_count bakım tetikleyicisi
-- ------------------------------------------------------------
create or replace function public.sync_forum_reply_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.forum_posts
    set reply_count = (select count(*) from public.forum_replies where post_id = OLD.post_id)
    where id = OLD.post_id;
    return OLD;
  end if;
  update public.forum_posts
  set reply_count = (select count(*) from public.forum_replies where post_id = NEW.post_id)
  where id = NEW.post_id;
  return NEW;
end;
$$;

drop trigger if exists forum_replies_count_trigger on public.forum_replies;
create trigger forum_replies_count_trigger
  after insert or delete on public.forum_replies
  for each row execute function public.sync_forum_reply_count();

-- Varsa eski satırların sayaçlarını düzelt (idempotent).
update public.forum_posts as p
set reply_count = coalesce(
  (select count(*) from public.forum_replies as r where r.post_id = p.id),
  0
);
