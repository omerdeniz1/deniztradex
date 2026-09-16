-- ============================================================
-- DenizTradeX — Forum karakter sınırı 280 → 500
--
-- Gönderi ve yanıt içerik kontrol kısıtları 500 karaktere
-- genişletilir (istemcideki FORUM_POST_MAX_LENGTH ile aynı).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.forum_posts
  drop constraint if exists forum_posts_content_check;

alter table public.forum_posts
  add constraint forum_posts_content_check
  check (char_length(content) between 1 and 500);

alter table public.forum_replies
  drop constraint if exists forum_replies_content_check;

alter table public.forum_replies
  add constraint forum_replies_content_check
  check (char_length(content) between 1 and 500);
