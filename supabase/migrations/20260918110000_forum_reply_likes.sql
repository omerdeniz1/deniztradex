-- ============================================================
-- DenizTradeX — Yanıt beğenme (reply likes)
--
-- `forum_reply_likes`: (reply_id, user_id) beğenileri;
-- `forum_replies.like_count` tetikleyici ile tutulur.
-- `toggle_forum_reply_like`: atomik beğen/geri-al (tek roundtrip).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.forum_replies
  add column if not exists like_count integer not null default 0;

create table if not exists public.forum_reply_likes (
  reply_id   uuid not null references public.forum_replies (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reply_id, user_id)
);

create index if not exists forum_reply_likes_user_id_idx
  on public.forum_reply_likes (user_id);

alter table public.forum_reply_likes enable row level security;

drop policy if exists forum_reply_likes_select_all on public.forum_reply_likes;
create policy forum_reply_likes_select_all
  on public.forum_reply_likes for select
  using (true);

drop policy if exists forum_reply_likes_insert_own on public.forum_reply_likes;
create policy forum_reply_likes_insert_own
  on public.forum_reply_likes for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_reply_likes_delete_own on public.forum_reply_likes;
create policy forum_reply_likes_delete_own
  on public.forum_reply_likes for delete
  using (auth.uid() = user_id);

grant select, insert, delete on public.forum_reply_likes to authenticated;
alter table public.forum_reply_likes enable row level security;

-- ------------------------------------------------------------
-- like_count bakım tetikleyicisi
-- ------------------------------------------------------------
create or replace function public.sync_forum_reply_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.forum_replies
    set like_count = (select count(*) from public.forum_reply_likes where reply_id = OLD.reply_id)
    where id = OLD.reply_id;
    return OLD;
  end if;
  update public.forum_replies
  set like_count = (select count(*) from public.forum_reply_likes where reply_id = NEW.reply_id)
  where id = NEW.reply_id;
  return NEW;
end;
$$;

drop trigger if exists forum_reply_likes_count_trigger on public.forum_reply_likes;
create trigger forum_reply_likes_count_trigger
  after insert or delete on public.forum_reply_likes
  for each row execute function public.sync_forum_reply_like_count();

-- ------------------------------------------------------------
-- Atomik beğen/geri-al. Dönen JSON: {"liked": true|false, "like_count": n}
-- ------------------------------------------------------------
create or replace function public.toggle_forum_reply_like(p_reply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_liked  boolean;
  v_count  integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('liked', false, 'like_count', 0);
  end if;

  perform 1 from public.forum_replies where id = p_reply_id for update;
  if not found then
    return jsonb_build_object('liked', false, 'like_count', 0);
  end if;

  if exists (
    select 1 from public.forum_reply_likes where reply_id = p_reply_id and user_id = v_uid
  ) then
    delete from public.forum_reply_likes where reply_id = p_reply_id and user_id = v_uid;
    v_liked := false;
  else
    insert into public.forum_reply_likes (reply_id, user_id) values (p_reply_id, v_uid);
    v_liked := true;
  end if;

  select like_count into v_count from public.forum_replies where id = p_reply_id;
  return jsonb_build_object('liked', v_liked, 'like_count', coalesce(v_count, 0));
end;
$$;

revoke all on function public.toggle_forum_reply_like(uuid) from public;
grant execute on function public.toggle_forum_reply_like(uuid) to authenticated;

-- Varsa eski satırların sayaçlarını düzelt (idempotent).
update public.forum_replies as r
set like_count = coalesce(
  (select count(*) from public.forum_reply_likes as l where l.reply_id = r.id),
  0
);
