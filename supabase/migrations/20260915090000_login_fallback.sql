-- ============================================================
-- DenizTradeX — login dayanıklılığı (Safari logout/login fix)
--
-- Kök neden: `profiles_select_own` politikası anonim (çıkış yapmış)
-- kullanıcıların `profiles` tablosunu okumasını engelliyordu. Login
-- ekranı kullanıcı adından e-postayı BULMAK İÇİN girişten ÖNCE
-- `profiles` okuması yapıyordu; bu okuma anon iken RLS tarafından
-- her zaman reddedildiği için "Kullanıcı bulunamadı" hatası
-- alınıyordu (özellikle Safari mobilde, signOut tamamlanınca).
--
-- Çözüm: giriş öncesi kullanıcı adı -> e-posta çözümlemesi için
-- RLS'yi baypas eden, yalnızca e-postayı döndüren SECURITY DEFINER
-- bir RPC fonksiyonu. E-posta zaten girişin kamuya açık
-- tanımlayıcısıdır (şifre olmadan tek başına işe yaramaz).
-- ============================================================

-- Kullanıcı adı / e-posta aramalarını büyük-küçük harf duyarsız ve
-- hızlı yapmak için yardımcı indexler.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

-- ------------------------------------------------------------
-- handle_new_user: çakışmalara dayanıklı hale getir.
-- Aynı id tekrar tetiklenirse (retry / yeniden deneme) sessizce
-- geç; kullanıcı adı çakışırsa benzersiz bir suffix ekle ki kayıt
-- asla profiles satırı olmadan kalmasın.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired_username text;
  final_username   text;
begin
  desired_username := nullif(btrim(coalesce(new.raw_user_meta_data->>'username', '')), '');
  if desired_username is null then
    desired_username := 'user_' || left(new.id::text, 8);
  end if;

  final_username := desired_username;

  begin
    insert into public.profiles (id, username, email, balance)
    values (new.id, final_username, coalesce(new.email, ''), 10000.00);
  exception
    when unique_violation then
      -- Aynı kullanıcı adı alınmışsa suffix dene, aynı id ise yoksay.
      begin
        final_username := left(desired_username, 40) || '_' || left(new.id::text, 8);
        insert into public.profiles (id, username, email, balance)
        values (new.id, final_username, coalesce(new.email, ''), 10000.00);
      exception
        when unique_violation then
          null; -- satır zaten var, sessizce geç
      end;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- resolve_login_email: giriş öncesi kullanıcı adı/e-posta -> e-posta
-- çözümlemesi. SECURITY DEFINER olduğu için anonim kullanıcılar da
-- çağırabilir; yalnızca eşleşen satırın e-postasını döndürür,
-- başka hiçbir kolon sızdırmaz.
-- ------------------------------------------------------------
create or replace function public.resolve_login_email(p_login text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_login is null or btrim(p_login) = '' then
    return null;
  end if;

  select p.email into v_email
  from public.profiles as p
  where lower(p.username) = lower(btrim(p_login))
     or lower(p.email) = lower(btrim(p_login))
  limit 1;

  return v_email;
end;
$$;

revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;
