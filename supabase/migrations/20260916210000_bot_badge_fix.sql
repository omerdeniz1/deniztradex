-- ============================================================
-- DenizTradeX — Bot rozet düzeltmesi (mavi tik)
--
-- Sorun: bot personaları forumda süper adminin `user_id`'siyle
-- postalandığı için `forum_verified_tier()` onlara 'super' (SARI tik)
-- basıyordu — insert tetikleyicisi, `admin_update_profile` rozet
-- tazeleme adımı ve geriye-dönük işaretlemelerin TAMAMI bu fonksiyondan
-- geçtiği için botlar idari bir işlem sonrası sarıya dönüyordu.
--
-- Çözüm: tek doğruluk kaynağı olan `forum_verified_tier()` içine bot
-- kontrolü (kullanıcı adından, user_id'den DEĞİL) eklenir + mevcut sarı
-- tikli bot yazıları maviye çekilir. Idempotent.
--
-- Locale notu: `lower('İ')` çoğu UTF-8 locale'de 'i'+birleşen nokta
-- (U+0307) üretir, C locale'de 'İ' kalır. `translate` eşlemesi
-- ('İ'→'i', 'I'→'ı', U+0307 silinir) eşleşmeyi locale'den bağımsız kılar.
-- ============================================================

create or replace function public.forum_verified_tier(p_user_id uuid, p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- Bot personaları HER ZAMAN mavi tik (user_id süper admin olsa bile).
    when translate(lower(trim(coalesce(p_username, ''))), 'İI' || chr(775), 'iı')
      in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı') then 'admin'
    when lower(coalesce(p_username, '')) = 'deniztradex' then 'super'
    when exists (select 1 from public.profiles where id = p_user_id and is_admin = true) then 'super'
    when exists (
      select 1 from public.profiles
      where id = p_user_id
        and coalesce(array_length(admin_permissions, 1), 0) > 0
    ) then 'admin'
    else 'none'
  end;
$$;

revoke all on function public.forum_verified_tier(uuid, text) from public;
grant execute on function public.forum_verified_tier(uuid, text) to anon, authenticated;

-- Mevcut sarı tikli bot yazılarını maviye çek (geriye dönük onarım).
update public.forum_posts as p
set verified_tier = 'admin',
    is_verified = true
where p.verified_tier <> 'admin'
  and translate(lower(trim(coalesce(p.username, ''))), 'İI' || chr(775), 'iı')
    in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı');

update public.forum_replies as r
set verified_tier = 'admin',
    is_verified = true
where r.verified_tier <> 'admin'
  and translate(lower(trim(coalesce(r.username, ''))), 'İI' || chr(775), 'iı')
    in ('elon musk', 'faik erdem', 'ilham memiş', 'ihsan memiş', 'kripto kaplanı');
