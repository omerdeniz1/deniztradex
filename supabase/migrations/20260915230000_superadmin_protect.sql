-- ============================================================
-- DenizTradeX — Süper admin dokunulmazlığı
--
-- Kural: `is_admin = true` olan bir hesaba (bakiye, dondur, yasakla,
-- para kısıtı, yetki, forum yazısı dahil) HİÇBİR alt yönetici
-- müdahale edemez; yalnızca süper admin dokunabilir. Kendine işlem
-- kuralları aynen korunur.
--
-- Uygulama noktaları:
--  1) Ayrıcalık koruma tetikleyicisi: hedef satır süper adminse ve
--     arayan süper değilse HER türlü güncellemeyi reddeder. RPC
--     (SECURITY DEFINER) içi güncellemelerde de tetikleyici çalışır ve
--     auth.uid() arayanı gösterir — yani tek kural bakiye/dondur/
--     yasakla/para kısıtı/yetki atamalarının TAMAMINI kapsar.
--  2) Forum silme politikaları: süper adminin yazı/yanıtlarını yalnız
--     süper admin silebilir.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Süper admin hedef dokunulmazlığı (tüm alanlar, tüm arayanlar).
  if OLD.is_admin = true and not public.is_admin() then
    raise exception 'süper admin hesabına müdahale edemezsin';
  end if;

  if (NEW.is_admin is distinct from OLD.is_admin
      or NEW.admin_permissions is distinct from OLD.admin_permissions) then
    if not public.is_admin()
       and not public.has_admin_permission(v_uid, 'manage_admins') then
      raise exception 'yetkisiz işlem: admin yönetimi yetkisi gerekli';
    end if;
  end if;

  if (NEW.is_frozen is distinct from OLD.is_frozen
      or NEW.is_banned is distinct from OLD.is_banned) then
    if not public.is_admin()
       and not public.has_admin_permission(v_uid, 'ban_users') then
      raise exception 'yetkisiz işlem: ban yetkisi gerekli';
    end if;
  end if;

  if (NEW.deposit_blocked is distinct from OLD.deposit_blocked
      or NEW.withdraw_blocked is distinct from OLD.withdraw_blocked) then
    if not public.is_admin()
       and not public.has_admin_permission(v_uid, 'restrict_money') then
      raise exception 'yetkisiz işlem: para işlemleri kısıtlama yetkisi gerekli';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists profiles_privilege_guard on public.profiles;
create trigger profiles_privilege_guard
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ------------------------------------------------------------
-- Forum: süper adminin yazı/yanıtlarını yalnız süper admin
-- silebilir. Alt yönetici (ban_users dahil) bu satırlara
-- dokunamaz; yetkisiz silme denemesi 0 satır döndürür.
-- ------------------------------------------------------------
drop policy if exists forum_posts_admin_delete on public.forum_posts;
create policy forum_posts_admin_delete
  on public.forum_posts for delete
  using (
    public.is_admin()
    or (
      public.has_admin_permission(auth.uid(), 'ban_users')
      and not exists (
        select 1 from public.profiles as pr
        where pr.id = forum_posts.user_id and pr.is_admin = true
      )
    )
  );

drop policy if exists forum_replies_admin_delete on public.forum_replies;
create policy forum_replies_admin_delete
  on public.forum_replies for delete
  using (
    public.is_admin()
    or (
      public.has_admin_permission(auth.uid(), 'ban_users')
      and not exists (
        select 1 from public.profiles as pr
        where pr.id = forum_replies.user_id and pr.is_admin = true
      )
    )
  );
