-- ============================================================
-- DenizTradeX — perakende botu için havuz realtime yayını
--
-- `virtual_coins` satırları (fiyat/hacim) `supabase_realtime` yayınına
-- eklenir: perakende botu (veya kullanıcı takasları) havuzu oynatınca
-- abone istemciler `postgres_changes` ile ANINDA görür (yoklama
-- beklemez). Tablo zaten herkese-açık okunur vitrindir
-- (`virtual_coins_select_all`), yeni veri sızıntısı yoktur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'virtual_coins'
  ) then
    alter publication supabase_realtime add table public.virtual_coins;
  end if;
end;
$$;
