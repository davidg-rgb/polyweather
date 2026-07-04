-- 0080_dash_city_forecast.sql — the PRE-PLACEMENT forecast that completes the /paper-trade current-bet box.
--
-- THE GAP (FASTTRACK-PLAN.md NIGHT-BUILD N2). The /paper-trade "Current bets" box reads dash_city_sim's
-- `latest` block — the most-recent PLACED bet per city. But bets are placed once a day by the 10:00 UTC
-- city-paper-trade tick; all morning (before the tick fires) the box shows YESTERDAY's bet, labelled
-- "today's bets not placed yet". The operator wants TODAY's INTENDED prediction shown pre-tick.
--
-- WHY A NEW RPC (data-path map). The number the sim WILL bet is wuRound of the bias-corrected lead-1
-- forecast center — the EXACT quantity city_sim_place_inputs (0070 §4) computes as `forecastC`. But that RPC
-- is service_role ONLY (the Edge tick's internal read); the web tier (anon-key session, authenticated as the
-- operator) cannot reach it. No operator-readable RPC carries a per-enrolled-city current-day forecast:
-- dash_city_sim (0070) carries only placed bets; dash_amsterdam_sim's `today` block (0052) is EHAM-hardcoded
-- and not portable; dash_data (0065) is aggregate accuracy history. So this adds ONE operator-readable read
-- rather than exposing the service-role internal.
--
-- WHAT IT RETURNS. A jsonb OBJECT (never a top-level array — the 0044 port trap): per ACTIVE city_sim_config
-- (the same active + active_until run-window gate as city_sim_active_configs / 0075, so a city whose window
-- has closed — the tick won't place — is omitted), TODAY's (city-local) pre-placement forecast:
--   • the day's lead-1 cross-model mean (avg over ALL of today's captures) (mirror of city_sim_place_inputs §4),
--   • trailing-30 debiased (verbatim city_sim_place_inputs / 0040/0041: ≥ 20 finalized pairs to trust the
--     correction) — DISPLAY falls back to the RAW mean when < 20 pairs so a number always shows (the 0052
--     `today` idiom), with `biasCorrected` flagging which,
--   • converted to the city's native unit (°F cities correct too, same conversion as 0070),
--   • wuRounded to the whole-° call (`predictedNative`),
--   • priced against today's live ladder (the containing bucket's `label` + its latest `best_ask`).
-- `alreadyPlacedToday` lets the box decide whether to show the intended prediction (pre-tick) or defer to the
-- placed bet. This is a FORECAST CENTER, not the bet: the running-max floor can still lift the actual call at
-- lock (nowcastBasisC = max(floor, forecast)), and late arms are pure-floor — the box says so.
--
-- operator_guard-gated, SECURITY DEFINER; grants mirror dash_data (0065): revoke public/anon/authenticated,
-- grant authenticated + service_role. No table, no cron (cron count unchanged). p_now is defaulted so the web
-- read is arg-less (`dash_city_forecast()`), while the migration twin can pin a deterministic "now".

create or replace function public.dash_city_forecast(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v        jsonb;
  cfg      record;
  v_cities jsonb := '[]'::jsonb;
  v_today  date;
  v_raw    numeric;    -- today's lead-1 cross-model mean (°C, avg over all captures), uncorrected
  v_nmod   int;        -- DISTINCT models behind that mean
  v_cap    timestamptz;-- freshest lead-1 capture instant for today (the "as of" stamp)
  v_bias   numeric;    -- trailing-30 mean(actual − forecast) residual (°C)
  v_bias_n int;        -- pairs behind the bias (≤ 30)
  v_corr   boolean;    -- whether the bias correction was trusted (≥ 20 pairs)
  v_fc_c   numeric;    -- displayed forecast (°C): corrected when trusted, else raw
  v_fc_nat numeric;    -- that forecast converted to the city's native unit
  v_pred   int;        -- wuRound(v_fc_nat) — today's whole-° call
  v_event  uuid;       -- today's market event for the city
  v_bid    uuid;       -- ladder bucket id containing v_pred
  v_label  text;       -- that bucket's label
  v_ask    numeric;    -- latest best_ask on that bucket
  v_placed boolean;    -- has the daily tick already placed today's bet for this city?
begin
  perform public.operator_guard();

  for cfg in
    select sc.city_id, sc.slug, sc.icao, sc.tz, sc.arm_hours, sc.forecast_max_hour,
           sc.stake_usd, sc.active_until, c.display_name, c.unit
    from public.city_sim_config sc
    join public.cities c on c.id = sc.city_id
    where sc.active
    order by sc.slug
  loop
    v_today := (p_now at time zone cfg.tz)::date;
    -- skip a city whose run window has closed (mirror city_sim_active_configs / 0075) — the tick won't place.
    if cfg.active_until is not null and v_today > cfg.active_until then
      continue;
    end if;

    -- reset per-city scratch (the loop reuses the declared locals)
    v_raw := null; v_nmod := null; v_cap := null; v_bias := null; v_bias_n := null;
    v_corr := false; v_fc_c := null; v_fc_nat := null; v_pred := null;
    v_event := null; v_bid := null; v_label := null; v_ask := null; v_placed := false;

    -- today's lead-1 cross-model mean — plain avg over ALL of today's lead-1 captures (mirror of city_sim_place_inputs §4).
    select avg(fs.tmax_c), count(distinct fs.model), max(fs.captured_at)
      into v_raw, v_nmod, v_cap
    from public.forecast_snapshots fs
    where fs.icao = cfg.icao and fs.target_date = v_today and fs.lead_days = 1;

    -- trailing-30 lead-1 residual bias (verbatim city_sim_place_inputs / 0041: tracks seasonal drift).
    with fc1 as (
      select fs.target_date, avg(fs.tmax_c) as fc
      from public.forecast_snapshots fs
      where fs.icao = cfg.icao and fs.lead_days = 1
      group by fs.target_date
    ),
    pairs as (
      select (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end) - fc1.fc as resid
      from public.observations o
      join fc1 on fc1.target_date = o.date_local
      where o.icao = cfg.icao and o.finalized_at is not null and o.tmax_wu_native is not null
        and o.date_local < v_today
      order by o.date_local desc
      limit 30
    )
    select avg(resid), count(*) into v_bias, v_bias_n from pairs;

    -- DISPLAY forecast: bias-corrected when ≥ 20 pairs, else the raw mean (0052 `today` idiom — always show a
    -- number). city_sim_place_inputs NULLs forecastC below the pair floor (→ pure floor); here we still show
    -- the raw center so the box has something to render, flagged biasCorrected=false.
    v_corr := (v_raw is not null and coalesce(v_bias_n, 0) >= 20);
    v_fc_c := case when v_raw is null then null
                   when v_corr then v_raw + coalesce(v_bias, 0)
                   else v_raw end;
    -- The market bucketizes in the city's NATIVE unit; the forecast is °C, so convert (0070 conversion).
    v_fc_nat := case when v_fc_c is null then null
                     when cfg.unit = 'F' then v_fc_c * 9.0 / 5.0 + 32 else v_fc_c end;
    v_pred := case when v_fc_nat is null then null else round(v_fc_nat)::int end;  -- wuRound (half away from 0)

    -- today's market event + the bucket our whole-° call lands in + that bucket's latest live ask.
    select me.id into v_event
    from public.market_events me
    where me.city_id = cfg.city_id and me.kind = 'highest' and me.target_date = v_today
    order by me.created_at desc
    limit 1;

    if v_event is not null and v_pred is not null then
      select mb.id, mb.label into v_bid, v_label
      from public.market_buckets mb
      where mb.event_id = v_event
        and (mb.low_native  is null or v_pred >= mb.low_native)
        and (mb.high_native is null or v_pred <= mb.high_native)
      order by mb.bucket_idx
      limit 1;

      if v_bid is not null then
        select ms.best_ask into v_ask
        from public.market_snapshots ms
        where ms.bucket_id = v_bid and ms.best_ask is not null
        order by ms.captured_at desc
        limit 1;
      end if;
    end if;

    -- has the daily tick already placed today's bet for this city? (lets the box choose intended vs placed).
    select exists(
      select 1 from public.city_paper_bets b
      where b.city_id = cfg.city_id and b.target_date = v_today
    ) into v_placed;

    v_cities := v_cities || jsonb_build_object(
      'cityId',             cfg.city_id,
      'slug',               cfg.slug,
      'displayName',        cfg.display_name,
      'icao',               cfg.icao,
      'unit',               cfg.unit,
      'tz',                 cfg.tz,
      'armHours',           cfg.arm_hours,
      'forecastMaxHour',    cfg.forecast_max_hour,
      'targetDate',         v_today,
      'hasMarket',          (v_event is not null),
      'capturedAt',         v_cap,
      'nModels',            v_nmod,
      'rawForecastC',       v_raw,
      'biasC',              v_bias,
      'biasN',              coalesce(v_bias_n, 0),
      'biasCorrected',      v_corr,
      'forecastC',          v_fc_c,
      'forecastNative',     v_fc_nat,
      'predictedNative',    v_pred,
      'label',              v_label,
      'ask',                v_ask,
      'alreadyPlacedToday', v_placed
    );
  end loop;

  v := jsonb_build_object('generatedAt', now(), 'cities', v_cities);
  return v;
end;
$$;

-- grants (post-0034 contract: operator-readable dashboard surface; the operator's logged-in session passes
-- operator_guard, serverDb calls it as authenticated). Mirrors dash_data (0065).
revoke all on function public.dash_city_forecast(timestamptz) from public, anon, authenticated;
grant  execute on function public.dash_city_forecast(timestamptz) to authenticated, service_role;
