-- ============================================================
-- DenizTradeX — Forum realtime (canlı akış)
--
-- `forum_posts` / `forum_replies` / `forum_likes` değişiklikleri
-- diğer cihazlara anında (<1 sn) düşsün diye tablolar
-- `supabase_realtime` yayınına eklenir. Yayın kapalıysa uygulama
-- yalnızca periyodik yoklamaya kalır (≈10-15 sn gecikme).
-- Idempotent: tablo zaten yayındaysa atlanır.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'forum_posts'
  ) then
    alter publication supabase_realtime add table public.forum_posts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'forum_replies'
  ) then
    alter publication supabase_realtime add table public.forum_replies;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'forum_likes'
  ) then
    alter publication supabase_realtime add table public.forum_likes;
  end if;
end;
$$;
