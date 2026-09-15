-- ============================================================
-- DenizTradeX — Leaderboard (Trader Skoru sıralaması)
--
-- `get_leaderboard(p_limit)`: herkese açık, salt-okunur RPC.
-- Trader Skoru = min-maks normalize edilmiş 3 bileşenin ağırlıklı
-- ortalaması (0-100):
--   %40 Toplam Portföy  (profiles.balance — hesap varlığı)
--   %30 İşlem Hacmi     (trade_buy + trade_sell toplam USDT)
--   %30 İşlem Performansı (satışlar - alışlar net USDT dengesi)
--
-- Güvenlik:
--  - SECURITY DEFINER tek okuma noktasıdır; e-posta/id sızmaz —
--    yalnızca vitrin kolonları döner (kullanıcı adı, avatar, rozet
--    bilgisi, portföy, hacim, kâr/zarar dengesi, işlem sayısı, skor).
--  - Yasaklı hesaplar (`is_banned`) sıralamaya alınmaz.
--  - Herkese açık akış (anon + authenticated çalıştırabilir), tıpkı
--    forum akışı gibi.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.get_leaderboard(p_limit integer default 50)
returns table (
  username       text,
  avatar_url     text,
  is_admin       boolean,
  has_permissions boolean,
  balance        numeric,
  volume         numeric,
  pnl            numeric,
  trades         bigint,
  score          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with agg as (
    select
      p.username as username,
      p.avatar_url as avatar_url,
      (p.is_admin = true) as is_admin,
      (coalesce(array_length(p.admin_permissions, 1), 0) > 0) as has_permissions,
      coalesce(p.balance, 0) as balance,
      coalesce(sum(
        case when t.type in ('trade_buy', 'trade_sell') then t.amount_usdt else 0 end
      ), 0) as volume,
      coalesce(sum(
        case
          when t.type = 'trade_sell' then t.amount_usdt
          when t.type = 'trade_buy' then -t.amount_usdt
          else 0
        end
      ), 0) as pnl,
      count(case when t.type in ('trade_buy', 'trade_sell') then 1 end) as trades
    from public.profiles as p
    left join public.transactions as t
      on t.user_id = p.id
    where coalesce(p.is_banned, false) = false
    group by p.id, p.username, p.avatar_url, p.is_admin, p.admin_permissions, p.balance
  ),
  mm as (
    select
      min(balance) as mn_b, max(balance) as mx_b,
      min(volume)  as mn_v, max(volume)  as mx_v,
      min(pnl)     as mn_p, max(pnl)     as mx_p
    from agg
  )
  select
    a.username,
    a.avatar_url,
    a.is_admin,
    a.has_permissions,
    a.balance,
    a.volume,
    a.pnl,
    a.trades,
    round(
      (
        0.40 * coalesce((a.balance - mm.mn_b) / nullif(mm.mx_b - mm.mn_b, 0), 1)
        + 0.30 * coalesce((a.volume - mm.mn_v) / nullif(mm.mx_v - mm.mn_v, 0), 1)
        + 0.30 * coalesce((a.pnl - mm.mn_p) / nullif(mm.mx_p - mm.mn_p, 0), 1)
      ) * 100,
      1
    ) as score
  from agg as a
  cross join mm
  order by score desc, volume desc, username asc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function public.get_leaderboard(integer) from public;
grant execute on function public.get_leaderboard(integer) to anon, authenticated;
