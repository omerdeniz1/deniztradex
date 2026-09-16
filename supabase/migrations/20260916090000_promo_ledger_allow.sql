-- ============================================================
-- DenizTradeX — Kısıtlı hesaba promosyon/referral serbestisi
--
-- Para kısıtı (`deposit_blocked`) YALNIZCA kartla yüklemeyi kapsar.
-- `guard_deposit_ledger` backstop'u tüm `deposit_history` satırlarını
-- reddediyordu; promosyon/referral bonusları da deftere düşmüyordu.
-- Bundan böyle bekçi yalnızca `source = 'card'` satırları reddeder;
-- `promo` / `referral` bonusları kısıtlı hesaba da işlenir.
-- Para çekme bekçisi (`withdraw` tipi) aynen korunur.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

create or replace function public.guard_deposit_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Promosyon/referral bonusları kısıttan muaftır; yalnızca kart
  -- yüklemeleri engellenir.
  if coalesce(NEW.source, 'card') <> 'card' then
    return NEW;
  end if;
  if exists (
    select 1 from public.profiles as p
    where p.id = NEW.user_id and p.deposit_blocked = true
  ) then
    raise exception 'para yatırma kısıtlı';
  end if;
  return NEW;
end;
$$;

drop trigger if exists deposit_ledger_guard on public.deposit_history;
create trigger deposit_ledger_guard
  before insert on public.deposit_history
  for each row execute function public.guard_deposit_ledger();
