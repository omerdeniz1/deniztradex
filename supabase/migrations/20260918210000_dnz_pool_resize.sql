-- ============================================================
-- DenizTradeX — DNZ havuz derinliği ayarı (perakende botu görünürlüğü)
--
-- Durum: DNZ havuzu 100M USDT / 200M DNZ açılmıştı. Bu derinlikte
-- 10–150$ perakende fişleri fiyatı ~%0.0003 oynatır — grafik ve %
-- pratikte kıpırdamaz, "canlı piyasa" hissi oluşmaz.
--
-- Çözüm: havuz 2M USDT / 4M DNZ'ye iner (oran korunur → fiyat yine
-- $0.50). 150$ fiş ~%0.015 etki yapar; kullanıcı takaslarında makul
-- kayma (%1 / 10B$) görülür. Toplam arz sabiti (200M) ve defterler
-- etkilenmez — değişen yalnızca piyasa yapıcı likiditesidir.
--
-- GÜVENLİK: yalnızca EL DEĞMEMİŞ havuza dokunur (rezervler tohumda ve
-- hacim 0). İşlem görmüş havuzda çalışırsa NOTICE bırakıp ÇIKAR —
-- fiyat şoku yaşatmaz.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================

do $$
declare
  v_rusdt  numeric;
  v_rtoken numeric;
  v_vol    numeric;
begin
  select reserve_usdt, reserve_token, volume_24h
    into v_rusdt, v_rtoken, v_vol
    from public.virtual_coins
    where symbol = 'DNZ';

  if not found then
    raise notice 'DNZ havuzu yok — 20260918180000 önce uygulanmalı.';
    return;
  end if;

  if v_rusdt = 100000000 and v_rtoken = 200000000 and coalesce(v_vol, 0) = 0 then
    update public.virtual_coins
    set reserve_usdt  = 2000000,
        reserve_token = 4000000,
        current_price = 0.5
    where symbol = 'DNZ';
  else
    raise notice 'DNZ havuzu işlem görmüş (R=%, T=%, vol=%) — derinlik korunuyor, elle ayarlayın.',
      v_rusdt, v_rtoken, v_vol;
  end if;
end;
$$;
