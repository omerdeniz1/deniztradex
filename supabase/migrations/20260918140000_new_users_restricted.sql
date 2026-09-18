-- ============================================================
-- DenizTradeX — Yeni üyeler kısıtlı başlar
--
-- Yeni kayıt olan hesapların para yatırma + para çekme işlemleri
-- varsayılan olarak KAPALI başlar; yönetici Admin Panel → Kısıtla
-- ekranından tek tek açar. Mevcut hesaplar etkilenmez (yalnızca
-- kolon varsayılanı + tetikleyici değişir).
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

alter table public.profiles
  alter column deposit_blocked set default true;

alter table public.profiles
  alter column withdraw_blocked set default true;

-- handle_new_user transfer migration'ında yeniden tanımlanmıştı;
-- kısıtları açık şekilde kapalı başlatır (varsayılana bel bağlamaz).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles
    (id, username, email, balance, wallet_no, deposit_blocked, withdraw_blocked)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    coalesce(new.email, ''),
    10000.00,
    public.make_wallet_no(new.id),
    true,
    true
  );
  return new;
end;
$$;
