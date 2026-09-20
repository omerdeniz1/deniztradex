-- ============================================================
-- DenizTradeX — sembol bazlı 24s değişim RPC'si
--
-- Hata: istemci `virtual_kline_data` tablosunu GLOBAL `limit(300)`
-- ile çekip ilk satırları eşleştiriyordu. Satır sayısı 300'ü aşınca
-- (botlar dakikada mum yazar) genç/seyrek işlem gören coinlerin
-- (örn. DNZ) satırları İKİ pencerenin de dışında kalıyor, 24s %
-- sürekli 0 görünüyordu — fiyat hareket etse bile.
--
-- Çözüm: `virtual_24h_changes()` her sembol için ayrı ayrı bakar:
-- 24s öncesine ait en yakın kapanış, yoksa en eski kapanış
-- (`(symbol, timestamp)` endeksiyle iki hızlı alt-sorgu). Tek
-- roundtrip, sayfalama körlüğü yok.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.virtual_24h_changes()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_object_agg(
      t.symbol,
      jsonb_build_object('change', t.change, 'change_pct', t.change_pct)
    ),
    '{}'::jsonb
  )
  from (
    select
      c.symbol as symbol,
      (c.current_price - coalesce(ref.close, early.close, c.current_price)) as change,
      case
        when coalesce(ref.close, early.close, c.current_price) > 0
        then ((c.current_price - coalesce(ref.close, early.close, c.current_price))
              / coalesce(ref.close, early.close, c.current_price)) * 100
        else 0
      end as change_pct
    from public.virtual_coins as c
    left join lateral (
      select k.close
      from public.virtual_kline_data as k
      where k.symbol = c.symbol
        and k.timestamp <= now() - interval '24 hours'
      order by k.timestamp desc
      limit 1
    ) as ref on true
    left join lateral (
      select k.close
      from public.virtual_kline_data as k
      where k.symbol = c.symbol
      order by k.timestamp asc
      limit 1
    ) as early on true
  ) as t;
$$;

revoke all on function public.virtual_24h_changes() from public;
grant execute on function public.virtual_24h_changes() to authenticated;
