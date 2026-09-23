-- ============================================================
-- DenizTradeX — Transfer %1.2 ücreti + forum görünen ismi
--
-- 1) TRANSFER ÜCRETİ (%1.2): gönderen tutar + ücret öder, alıcı tutarın
--    tamamını alır, ücret platforma kalır (deftere `fee` satırı işlenir).
--    `transfer_assets` (USDT + spot + sanal) ve `transfer_dnz` bu kurala
--    geçer; istemci aynı hesabı yapar (yerel mod + özet ekranı).
-- 2) GÖRÜNEN İSİM: `profiles.display_name` (en fazla 30 karakter) —
--    kullanıcı profilinden belirler; forumda isim olarak BU görünür,
--    altında `@kullanıcıadı` yazılır. Kullanıcı adı kimlik olarak kalır
--    (giriş, mention, rozet mantığı değişmez).
--    - `forum_posts.display_name` / `forum_replies.display_name`: yazı
--      anında profilden damgalanır, profil değişince eski yazılara yayılır
--      (user_tag mekaniğiyle aynı).
--    - Bot/persona gönderilerinde görünen isim bot/persona adıdır
--      (`post_bot_message` düzeltir; adminin kendi ismi basılmaz).
--    - `get_public_profile` çıktısına `display_name` eklenir.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Defter `fee` tipi güvencesi (eski DB sırası karışmış olabilir)
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'transactions_type_check') then
    alter table public.transactions drop constraint transactions_type_check;
  end if;
  alter table public.transactions
    add constraint transactions_type_check
    check (type in ('trade_buy','trade_sell','withdraw','promo','referral',
                    'transfer_in','transfer_out','fee'));
end;
$$;

-- ------------------------------------------------------------
-- 1) transfer_assets: %1.2 ücretli (gönderen öder)
-- ------------------------------------------------------------
create or replace function public.transfer_assets(
  p_receiver_wallet text,
  p_asset          text,
  p_amount         numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender   uuid := auth.uid();
  v_receiver uuid;
  v_asset    text := upper(trim(both from coalesce(p_asset, '')));
  v_fee_rate constant numeric := 0.012;
  v_fee      numeric;
  v_total    numeric;
  v_qty      numeric;
  v_bal      numeric;
  v_hold     numeric;
  v_new      numeric;
begin
  if v_sender is null then
    raise exception 'giriş gerekli';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'geçersiz tutar';
  end if;
  if v_asset = '' then
    raise exception 'geçersiz varlık';
  end if;

  v_fee := p_amount * v_fee_rate;
  v_total := p_amount + v_fee;

  select id into v_receiver
  from public.profiles
  where upper(wallet_no) = upper(trim(both from coalesce(p_receiver_wallet, '')))
  limit 1;
  if not found then
    raise exception 'alıcı bulunamadı';
  end if;
  if v_receiver = v_sender then
    raise exception 'kendine transfer yapamazsın';
  end if;

  if v_asset = 'USDT' then
    select balance into v_bal from public.profiles where id = v_sender for update;
    if v_bal is null then
      raise exception 'profil bulunamadı';
    end if;
    if v_bal < v_total then
      raise exception 'yetersiz USDT bakiyesi (ücret dahil)';
    end if;

    update public.profiles set balance = balance - v_total where id = v_sender;
    update public.profiles set balance = balance + p_amount where id = v_receiver;

    insert into public.transactions (user_id, type, amount_usdt)
    values (v_sender, 'transfer_out', p_amount),
           (v_sender, 'fee', v_fee),
           (v_receiver, 'transfer_in', p_amount);

    return jsonb_build_object('ok', true, 'asset', 'USDT', 'amount', p_amount, 'fee', v_fee);
  end if;

  -- Sanal coin mi?
  if exists (select 1 from public.virtual_coins where symbol = v_asset) then
    select quantity into v_hold
    from public.virtual_holdings
    where user_id = v_sender and symbol = v_asset;
    if coalesce(v_hold, 0) < v_total then
      raise exception 'yetersiz coin bakiyesi (ücret dahil)';
    end if;

    update public.virtual_holdings
    set quantity = quantity - v_total
    where user_id = v_sender and symbol = v_asset;

    insert into public.virtual_holdings (user_id, symbol, quantity)
    values (v_receiver, v_asset, p_amount)
    on conflict (user_id, symbol)
    do update set quantity = public.virtual_holdings.quantity + excluded.quantity;

    insert into public.transactions (user_id, type, symbol, side, quantity, amount_usdt)
    values (v_sender, 'transfer_out', v_asset, 'sell', p_amount, p_amount),
           (v_sender, 'fee', v_asset, 'sell', v_fee, v_fee),
           (v_receiver, 'transfer_in', v_asset, 'buy', p_amount, p_amount);

    return jsonb_build_object('ok', true, 'asset', v_asset, 'amount', p_amount, 'fee', v_fee);
  end if;

  -- Spot coin: trading_state.spot_balances JSONB taşınır.
  select (spot_balances ->> v_asset)::numeric into v_qty
  from public.trading_state
  where user_id = v_sender;
  if coalesce(v_qty, 0) < v_total then
    raise exception 'yetersiz coin bakiyesi (ücret dahil)';
  end if;

  insert into public.trading_state (user_id, spot_balances)
  values (v_sender, '{}'::jsonb)
  on conflict (user_id) do nothing;

  update public.trading_state
  set spot_balances = coalesce(spot_balances, '{}'::jsonb) ||
        jsonb_build_object(v_asset, greatest(coalesce((spot_balances ->> v_asset)::numeric, 0) - v_total, 0)),
      updated_at = now()
  where user_id = v_sender;

  insert into public.trading_state (user_id, spot_balances)
  values (v_receiver, '{}'::jsonb)
  on conflict (user_id) do nothing;

  update public.trading_state
  set spot_balances = coalesce(spot_balances, '{}'::jsonb) ||
        jsonb_build_object(v_asset, coalesce((spot_balances ->> v_asset)::numeric, 0) + p_amount),
      updated_at = now()
  where user_id = v_receiver;

  insert into public.transactions (user_id, type, symbol, side, quantity, amount_usdt)
  values (v_sender, 'transfer_out', v_asset || 'USDT', 'sell', p_amount, p_amount),
         (v_sender, 'fee', v_asset || 'USDT', 'sell', v_fee, v_fee),
         (v_receiver, 'transfer_in', v_asset || 'USDT', 'buy', p_amount, p_amount);

  return jsonb_build_object('ok', true, 'asset', v_asset, 'amount', p_amount, 'fee', v_fee);
end;
$$;

revoke all on function public.transfer_assets(text, text, numeric) from public;
grant execute on function public.transfer_assets(text, text, numeric) to authenticated;

-- ------------------------------------------------------------
-- 2) transfer_dnz: %1.2 ücretli (gönderen öder)
-- ------------------------------------------------------------
create or replace function public.transfer_dnz(
  p_receiver_wallet text,
  p_amount          numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender   uuid := auth.uid();
  v_receiver uuid;
  v_qty      numeric := p_amount;
  v_fee_rate constant numeric := 0.012;
  v_fee      numeric;
  v_total    numeric;
  v_bal      numeric;
begin
  if v_sender is null then
    raise exception 'giriş gerekli';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'geçersiz tutar';
  end if;

  v_fee := v_qty * v_fee_rate;
  v_total := v_qty + v_fee;

  select id into v_receiver
  from public.profiles
  where upper(wallet_no) = upper(trim(both from coalesce(p_receiver_wallet, '')))
  limit 1;
  if not found then
    raise exception 'alıcı bulunamadı';
  end if;
  if v_receiver = v_sender then
    raise exception 'kendine transfer yapamazsın';
  end if;

  select balance into v_bal
  from public.dnz_balances
  where user_id = v_sender
  for update;
  if coalesce(v_bal, 0) < v_total then
    raise exception 'yetersiz DNZ bakiyesi (ücret dahil)';
  end if;

  update public.dnz_balances
  set balance = balance - v_total, updated_at = now()
  where user_id = v_sender;

  insert into public.dnz_balances (user_id, balance)
  values (v_receiver, v_qty)
  on conflict (user_id)
  do update set balance = public.dnz_balances.balance + excluded.balance,
                updated_at = now();

  insert into public.dnz_ledger (user_id, type, amount_dnz, balance_after)
  values
    (v_sender, 'transfer_out', v_qty, coalesce(v_bal, 0) - v_total),
    (v_receiver, 'transfer_in', v_qty,
      (select balance from public.dnz_balances where user_id = v_receiver));

  insert into public.transactions (user_id, type, symbol, side, quantity)
  values (v_sender, 'transfer_out', 'DNZ', 'sell', v_qty),
         (v_sender, 'fee', 'DNZ', 'sell', v_fee),
         (v_receiver, 'transfer_in', 'DNZ', 'buy', v_qty);

  return jsonb_build_object('ok', true, 'asset', 'DNZ', 'amount', v_qty, 'fee', v_fee);
end;
$$;

revoke all on function public.transfer_dnz(text, numeric) from public;
grant execute on function public.transfer_dnz(text, numeric) to authenticated;

-- ------------------------------------------------------------
-- 3) Görünen isim (display_name)
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists display_name text;

alter table public.forum_posts
  add column if not exists display_name text;

alter table public.forum_replies
  add column if not exists display_name text;

-- Yazı damgası: görünen ismi profilden al (yoksa kullanıcı adı).
create or replace function public.sync_forum_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avatar text;
  v_tag text;
  v_display text;
begin
  select p.avatar_url, p.user_tag, p.display_name
    into v_avatar, v_tag, v_display
  from public.profiles as p
  where p.id = NEW.user_id;

  NEW.verified_tier := public.forum_verified_tier(NEW.user_id, NEW.username);
  NEW.is_verified := (NEW.verified_tier <> 'none');
  NEW.avatar_url := v_avatar;
  if NEW.user_tag is null then
    NEW.user_tag := v_tag;
  end if;
  if NEW.display_name is null then
    NEW.display_name := nullif(trim(coalesce(v_display, '')), '');
    if NEW.display_name is null then
      NEW.display_name := NEW.username;
    end if;
  end if;

  return NEW;
end;
$$;

-- Profil değişince eski yazılara yay (isim + etiket + görünen isim).
create or replace function public.sync_profile_forum_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.username is distinct from OLD.username
     or NEW.user_tag is distinct from OLD.user_tag
     or NEW.display_name is distinct from OLD.display_name then
    update public.forum_posts
    set username = NEW.username,
        user_tag = NEW.user_tag,
        display_name = coalesce(nullif(trim(NEW.display_name), ''), NEW.username)
    where user_id = NEW.id;

    update public.forum_replies
    set username = NEW.username,
        user_tag = NEW.user_tag,
        display_name = coalesce(nullif(trim(NEW.display_name), ''), NEW.username)
    where user_id = NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_forum_identity_cascade on public.profiles;
create trigger profiles_forum_identity_cascade
  after update of username, user_tag, display_name on public.profiles
  for each row execute function public.sync_profile_forum_identity();

-- Geriye dönük damga (idempotent).
update public.forum_posts as p
set display_name = coalesce(nullif(trim(pr.display_name), ''), p.username)
from public.profiles as pr
where pr.id = p.user_id
  and p.display_name is distinct from coalesce(nullif(trim(pr.display_name), ''), p.username);

update public.forum_replies as r
set display_name = coalesce(nullif(trim(pr.display_name), ''), r.username)
from public.profiles as pr
where pr.id = r.user_id
  and r.display_name is distinct from coalesce(nullif(trim(pr.display_name), ''), r.username);

-- ------------------------------------------------------------
-- 4) Bot mesajında görünen isim (admin ismi basılmaz)
-- ------------------------------------------------------------
create or replace function public.post_bot_message(
  p_username   text,
  p_content    text,
  p_fake_likes integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_base integer := 0;
  v_display text := trim(coalesce(p_username, ''));
begin
  if not public.is_admin() then
    raise exception 'yetkisiz işlem: yalnızca süper admin bot çalıştırabilir';
  end if;

  if coalesce(trim(p_username), '') = '' then
    raise exception 'geçersiz bot adı';
  end if;
  if coalesce(trim(p_content), '') = '' then
    raise exception 'geçersiz mesaj';
  end if;
  if char_length(p_content) > 500 then
    raise exception 'mesaj en fazla 500 karakter olabilir';
  end if;

  if lower(trim(p_username)) in
     ('deniztradexx', 'omerbabaparayapmakta', 'blackrock') then
    v_base := 10000 + floor(random() * 10001)::integer;
  end if;

  -- Persona vitrin adını kullan (yoksa bot kullanıcı adı).
  select display_name into v_display
  from public.persona_profiles
  where lower(username) = lower(trim(p_username));
  if not found or coalesce(trim(v_display), '') = '' then
    v_display := trim(p_username);
  end if;

  insert into public.forum_posts (user_id, username, content, like_count, base_likes)
  values (v_uid, trim(p_username), trim(p_content),
          greatest(coalesce(p_fake_likes, 0), 0) + v_base, v_base)
  returning id into v_id;

  update public.forum_posts
    set verified_tier = 'admin',
        is_verified = true,
        avatar_url = null,
        display_name = v_display
    where id = v_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 5) Herkese açık profil çıktısına görünen isim
-- ------------------------------------------------------------
create or replace function public.get_public_profile(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text := lower(trim(coalesce(p_username, '')));
  v_uid uuid := auth.uid();
  v_persona public.persona_profiles%rowtype;
  v_profile public.profiles%rowtype;
  v_base bigint := 0;
  v_tier text := 'none';
  v_name text;
  v_display text;
  v_bio text := '';
  v_avatar text := null;
  v_created timestamptz := null;
  v_followers bigint;
  v_following bigint;
  v_posts bigint;
  v_is_following boolean := false;
begin
  if v_key = '' then
    return null;
  end if;

  select * into v_persona
  from public.persona_profiles
  where lower(username) = v_key;

  if found then
    v_name := v_persona.username;
    v_display := v_persona.display_name;
    v_bio := coalesce(v_persona.bio, '');
    v_avatar := v_persona.avatar_url;
    v_base := coalesce(v_persona.follower_base, 0);
    v_tier := coalesce(v_persona.verified_tier, 'admin');
    v_created := v_persona.created_at;
  else
    select * into v_profile
    from public.profiles
    where lower(username) = v_key;
    if not found then
      return null;
    end if;
    v_name := v_profile.username;
    v_display := nullif(trim(coalesce(v_profile.display_name, '')), '');
    if v_display is null then
      v_display := v_profile.username;
    end if;
    v_bio := coalesce(v_profile.bio, '');
    v_avatar := v_profile.avatar_url;
    v_base := coalesce(v_profile.follower_base, 0);
    v_tier := public.forum_verified_tier(v_profile.id, v_profile.username);
    v_created := v_profile.created_at;
  end if;

  select count(*) into v_followers
  from public.forum_follows
  where following_username = v_key;

  if v_persona.username is null then
    select count(*) into v_following
    from public.forum_follows
    where follower_id = (
      select id from public.profiles where lower(username) = v_key
    );
  else
    v_following := 0;
  end if;

  if v_uid is not null then
    select exists (
      select 1 from public.forum_follows
      where follower_id = v_uid and following_username = v_key
    ) into v_is_following;
  end if;

  select count(*) into v_posts
  from public.forum_posts
  where lower(username) = v_key;

  return jsonb_build_object(
    'ok', true,
    'username', v_display,
    'handle', v_key,
    'bio', v_bio,
    'avatar_url', v_avatar,
    'verified_tier', v_tier,
    'created_at', v_created,
    'followers', v_base + coalesce(v_followers, 0),
    'following', coalesce(v_following, 0),
    'posts', coalesce(v_posts, 0),
    'is_following', coalesce(v_is_following, false),
    'is_persona', (v_persona.username is not null)
  );
end;
$$;

revoke all on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated;
