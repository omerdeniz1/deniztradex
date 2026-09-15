-- ============================================================
-- DenizTradeX — Forum (Topluluk) sekmesi
--
-- `forum_posts`: kullanıcı gönderileri (280 karakter, X tarzı).
-- `forum_likes`: beğeniler; `like_count` tetikleyici ile tutulur.
-- `toggle_forum_like`: atomik beğen/geri-al (tek roundtrip).
-- ============================================================

create table if not exists public.forum_posts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  username   text not null,
  content    text not null check (char_length(content) between 1 and 280),
  like_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists forum_posts_created_at_idx
  on public.forum_posts (created_at desc);

create index if not exists forum_posts_user_id_idx
  on public.forum_posts (user_id);

create table if not exists public.forum_likes (
  post_id    uuid not null references public.forum_posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists forum_likes_user_id_idx
  on public.forum_likes (user_id);

alter table public.forum_posts enable row level security;
alter table public.forum_likes  enable row level security;

-- Herkes okur (topluluk akışı herkese açık).
drop policy if exists forum_posts_select_all on public.forum_posts;
create policy forum_posts_select_all
  on public.forum_posts for select
  using (true);

-- Yalnızca kendi adına yazabilir / silebilir.
drop policy if exists forum_posts_insert_own on public.forum_posts;
create policy forum_posts_insert_own
  on public.forum_posts for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_posts_delete_own on public.forum_posts;
create policy forum_posts_delete_own
  on public.forum_posts for delete
  using (auth.uid() = user_id);

drop policy if exists forum_likes_select_all on public.forum_likes;
create policy forum_likes_select_all
  on public.forum_likes for select
  using (true);

drop policy if exists forum_likes_insert_own on public.forum_likes;
create policy forum_likes_insert_own
  on public.forum_likes for insert
  with check (auth.uid() = user_id);

drop policy if exists forum_likes_delete_own on public.forum_likes;
create policy forum_likes_delete_own
  on public.forum_likes for delete
  using (auth.uid() = user_id);

grant select on public.forum_posts to anon, authenticated;
grant insert, delete on public.forum_posts to authenticated;
grant select, insert, delete on public.forum_likes to authenticated;

-- ------------------------------------------------------------
-- like_count bakım tetikleyicisi (istemci sayaç yazamaz —
-- update politikası yok; yalnızca bu definer fonksiyon yazar).
-- ------------------------------------------------------------
create or replace function public.sync_forum_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.forum_posts
    set like_count = (select count(*) from public.forum_likes where post_id = OLD.post_id)
    where id = OLD.post_id;
    return OLD;
  end if;
  update public.forum_posts
  set like_count = (select count(*) from public.forum_likes where post_id = NEW.post_id)
  where id = NEW.post_id;
  return NEW;
end;
$$;

drop trigger if exists forum_likes_count_trigger on public.forum_likes;
create trigger forum_likes_count_trigger
  after insert or delete on public.forum_likes
  for each row execute function public.sync_forum_like_count();

-- ------------------------------------------------------------
-- Atomik beğen/geri-al: satır kilidi + tek işlem. Dönen JSON:
-- {"liked": true|false, "like_count": n}
-- ------------------------------------------------------------
create or replace function public.toggle_forum_like(p_post_id uuid)
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

  perform 1 from public.forum_posts where id = p_post_id for update;
  if not found then
    return jsonb_build_object('liked', false, 'like_count', 0);
  end if;

  if exists (
    select 1 from public.forum_likes where post_id = p_post_id and user_id = v_uid
  ) then
    delete from public.forum_likes where post_id = p_post_id and user_id = v_uid;
    v_liked := false;
  else
    insert into public.forum_likes (post_id, user_id) values (p_post_id, v_uid);
    v_liked := true;
  end if;

  select like_count into v_count from public.forum_posts where id = p_post_id;
  return jsonb_build_object('liked', v_liked, 'like_count', coalesce(v_count, 0));
end;
$$;

revoke all on function public.toggle_forum_like(uuid) from public;
grant execute on function public.toggle_forum_like(uuid) to authenticated;
