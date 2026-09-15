-- ============================================================
-- DenizTradeX — Profil canlı senkronu (bakiye anında yansısın)
--
-- `profiles` tablosu `supabase_realtime` yayınına eklenir: yönetici
-- bakiyeyi değiştirince (veya hesabı dondurup yasaklayınca) kullanıcının
-- açık uygulaması olayı anında alır, çıkış-giriş gerekmez.
--
-- Gizlilik: realtime RLS'ye tabidir; herkes YALNIZCA kendi satırının
-- güncellemelerini alır (`profiles_select_own`).
--
-- Idempotent: tablo zaten yayındaysa atlanır.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end;
$$;
