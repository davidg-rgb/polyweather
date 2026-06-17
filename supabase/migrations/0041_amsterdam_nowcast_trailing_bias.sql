-- 0041_amsterdam_nowcast_trailing_bias.sql — track the seasonal forecast bias with a trailing window.
--
-- Review follow-up to 0040. The bias correction in amsterdam_sim_place_inputs was an UNBOUNDED all-history
-- mean of (actual − lead-1 forecast). Amsterdam's lead-1 bias drifts seasonally (≈+0.4°C spring → +0.83°C
-- June), so an expanding mean dilutes the current bias toward the old one. Switching to a TRAILING window
-- of the most recent AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS (=30) finalized pairs tracks the drift and, on the
-- walk-forward backtest (scripts/amsterdam-nowcast-backtest.ts, 69 test days), beats all-history at the
-- early arms: 13:00 exact-hit 58%→62% and — unlike all-history (p=0.090) — clears significance (McNemar
-- exact p=0.024); MAE 0.45→0.41. The window/min-pairs are MIRRORS of the constants in
-- core/sim/amsterdam.ts (AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS / _MIN_PAIRS) and the backtest — keep in lockstep.
--
-- Only amsterdam_sim_place_inputs changes (the bias CTE). amsterdam_sim_record / dash_amsterdam_sim
-- (0040) are unchanged. Also fixes two stale 0039 column comments and documents the cross-model mean.

create or replace function public.amsterdam_sim_place_inputs(
  p_target date,
  p_now    timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_fee      numeric;
  v_today    date := (p_now at time zone 'Etc/GMT-2')::date;
  v_now_hour int  := extract(hour from (p_now at time zone 'Etc/GMT-2'))::int;
  v_ladder   jsonb;
  v_labels   jsonb;
  v_arms     jsonb;
  v_raw_fc   numeric;   -- cross-model lead-1 mean forecast for the target day (°C)
  v_bias     numeric;   -- mean(actual − forecast) over the trailing window of prior finalized pairs
  v_bias_n   int;       -- how many pairs the bias estimate is built from (<= the window)
  v_forecast numeric;   -- the corrected forecast handed to the engine (null = fall back to floor)
begin
  select me.id into v_event_id
  from public.market_events me
  join public.cities c on c.id = me.city_id
  where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = p_target
  order by me.created_at desc
  limit 1;
  if v_event_id is null then
    return null;
  end if;

  select coalesce(min(fee_rate), 0) into v_fee
  from public.market_buckets where event_id = v_event_id;

  select
    jsonb_agg(jsonb_build_object('bucketIdx', bucket_idx, 'low', low_native, 'high', high_native)
              order by bucket_idx),
    jsonb_object_agg(bucket_idx, label)
  into v_ladder, v_labels
  from public.market_buckets where event_id = v_event_id;
  if v_ladder is null then
    return null;
  end if;

  -- Bias-corrected lead-1 forecast of the day's high (°C). Both pieces are known before the day starts
  -- (no look-ahead). v_raw_fc = cross-model mean over ALL lead-1 captures for the day (matches the 0038
  -- /city blend; a model with both 10Z+22Z slots is weighted by its captures — the same mean is used for
  -- v_raw_fc and the bias, so any slot-weighting cancels in v_raw_fc + v_bias).
  select avg(fs.tmax_c) into v_raw_fc
  from public.forecast_snapshots fs
  where fs.icao = 'EHAM' and fs.target_date = p_target and fs.lead_days = 1;

  -- v_bias = mean residual over the TRAILING 30 finalized days (strictly before the target) that had a
  -- lead-1 forecast — tracks the seasonal drift instead of an all-history mean. Require >= 20 pairs.
  with fc1 as (
    select fs.target_date, avg(fs.tmax_c) as fc
    from public.forecast_snapshots fs
    where fs.icao = 'EHAM' and fs.lead_days = 1
    group by fs.target_date
  ),
  pairs as (
    select (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end) - fc1.fc as resid
    from public.observations o
    join fc1 on fc1.target_date = o.date_local
    where o.icao = 'EHAM' and o.finalized_at is not null and o.tmax_wu_native is not null
      and o.date_local < p_target
    order by o.date_local desc
    limit 30   -- AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS (mirror core/sim/amsterdam.ts)
  )
  select avg(resid), count(*) into v_bias, v_bias_n from pairs;

  v_forecast := case when v_raw_fc is not null and coalesce(v_bias_n, 0) >= 20   -- AMSTERDAM_SIM_DEBIAS_MIN_PAIRS
                     then v_raw_fc + coalesce(v_bias, 0) end;

  with due as (
    select h from unnest(array[13, 14, 15, 16]) h
    where (p_target < v_today or (p_target = v_today and h <= v_now_hour))
      and not exists (
        select 1 from public.amsterdam_paper_bets b
        where b.target_date = p_target and b.arm_hour = h
      )
  ),
  rm as (
    select due.h,
      (select max(ia.max_tenths_c) from public.intraday_advances ia
       where ia.icao = 'EHAM' and ia.date_local = p_target and ia.local_hour <= due.h) as runmax,
      (p_target::timestamp + make_interval(hours => due.h + 1)) at time zone 'Etc/GMT-2' as asof
    from due
  ),
  armed as (
    select rm.h, rm.runmax,
      (select jsonb_agg(jsonb_build_object('bucketIdx', mb.bucket_idx, 'ask',
                (select ms.best_ask from public.market_snapshots ms
                 where ms.bucket_id = mb.id and ms.captured_at < rm.asof and ms.best_ask is not null
                 order by ms.captured_at desc limit 1))
              order by mb.bucket_idx)
       from public.market_buckets mb where mb.event_id = v_event_id) as asks
    from rm
    where rm.runmax is not null
  )
  select jsonb_agg(jsonb_build_object('hour', h, 'runMaxC', runmax, 'asks', asks) order by h)
  into v_arms from armed;

  return jsonb_build_object(
    'targetDate', p_target,
    'eventId',    v_event_id,
    'feeRate',    v_fee,
    'ladder',     v_ladder,
    'labels',     v_labels,
    'forecastC',  v_forecast,
    'arms',       coalesce(v_arms, '[]'::jsonb)
  );
end;
$$;

-- create-or-replace preserves grants; re-assert the post-0034 contract (service_role only).
revoke all on function public.amsterdam_sim_place_inputs(date, timestamptz) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_place_inputs(date, timestamptz) to service_role;

-- Refresh the 0039 column comments superseded by the forecast lift (0040): predicted_native_c is now the
-- whole-°C call from the lifted basis, and running_max_c is the hard floor (no longer always "what drove
-- the call" — the forecast may have lifted it at arms <= 14).
comment on column public.amsterdam_paper_bets.predicted_native_c is
  'Whole-°C call: wuRound(max(running_max_c, forecast_c)) at arms <= 14 (when forecast_c is set), else wuRound(running_max_c).';
comment on column public.amsterdam_paper_bets.running_max_c is
  'The hard running-max floor (°C) known by the arm hour. The basis equals this unless the forecast lifted it (see forecast_c).';
