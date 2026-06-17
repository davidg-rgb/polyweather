-- 0040_amsterdam_forecast_nowcast.sql — make the Amsterdam nowcast forecast-aware.
--
-- The 0039 sim predicts the day's WU high as wuRound(running max) at each lock hour. The running max
-- is a hard FLOOR (the high can only finish ≥ what's already happened), but early in the day it
-- under-predicts the peak (the day keeps warming) — raw running max is only 42% exact at 13:00 on the
-- backtest window. This migration lifts the floor to the bias-corrected NWP forecast of the day's high
-- at the EARLY arms (≤ AMSTERDAM_SIM_FORECAST_MAX_HOUR = 14): basis = max(floor, forecast). A
-- walk-forward backtest over 69 post-warmup test days (scripts/amsterdam-nowcast-backtest.ts) measures
-- the 13:00/14:00 lift, with 15:00/16:00 untouched (the floor already peaks there; the forecast only
-- adds noise). [Current figures live in AMSTERDAM-SIM.md; migration 0041 later replaced the all-history
-- bias below with a trailing window — 13:00 42%→62%, McNemar p=0.024.] The place/round DECISION lives
-- once in @weather-edge/core (sim/amsterdam.ts — nowcastBasisC/planPlacements); this migration only
-- feeds it the forecast and stores what was used.
--
-- forecast (per day) = cross-model MEAN of forecast_snapshots.tmax_c at lead_days = 1 (the same blend
-- the /city panel scores), bias-corrected by the mean (actual − forecast) over finalized days STRICTLY
-- BEFORE the target (walk-forward, no look-ahead — exactly the lead-1 bias dash_station_predictions
-- surfaces). Require ≥ 20 prior pairs or the correction is too noisy → null, and the engine falls back
-- to the original pure-floor call. No new RPC signatures, no new surface: the Edge Function and the
-- seed script consume the richer place-inputs payload unchanged.

-- --- column: what (if anything) lifted the call -----------------------------------------------------
alter table public.amsterdam_paper_bets
  add column if not exists forecast_c numeric(5,2);   -- lead-1 forecast (°C), corrected for trailing bias; null = none

comment on column public.amsterdam_paper_bets.forecast_c is
  'Lead-1 NWP forecast of the day high (°C), corrected for its trailing bias, available at placement; null when unavailable. '
  'The call is wuRound(max(running_max_c, forecast_c)) at arms <= 14, else wuRound(running_max_c).';

-- --- place inputs (now forecast-aware) --------------------------------------------------------------
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
  v_bias     numeric;   -- trailing mean(actual − forecast) over prior finalized days
  v_bias_n   int;       -- how many prior pairs the bias estimate is built from
  v_forecast numeric;   -- the corrected forecast handed to the engine (null = fall back to floor)
begin
  select me.id into v_event_id
  from public.market_events me
  join public.cities c on c.id = me.city_id
  where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = p_target
  order by me.created_at desc
  limit 1;
  if v_event_id is null then
    return null;  -- no Amsterdam market for that day (e.g. before discovery, or a gap)
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

  -- Bias-corrected lead-1 forecast of the day's high (°C). Both pieces are known before the day starts, so
  -- this is not look-ahead: v_raw_fc is the pre-day capture; v_bias is measured ONLY on days < target.
  select avg(fs.tmax_c) into v_raw_fc
  from public.forecast_snapshots fs
  where fs.icao = 'EHAM' and fs.target_date = p_target and fs.lead_days = 1;

  with fc1 as (
    select fs.target_date, avg(fs.tmax_c) as fc
    from public.forecast_snapshots fs
    where fs.icao = 'EHAM' and fs.lead_days = 1
    group by fs.target_date
  )
  select
    avg((case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end) - fc1.fc),
    count(*)
  into v_bias, v_bias_n
  from public.observations o
  join fc1 on fc1.target_date = o.date_local
  where o.icao = 'EHAM' and o.finalized_at is not null and o.tmax_wu_native is not null
    and o.date_local < p_target;

  v_forecast := case when v_raw_fc is not null and coalesce(v_bias_n, 0) >= 20
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

-- --- record placements (now persists forecast_c) ----------------------------------------------------
create or replace function public.amsterdam_sim_record(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.amsterdam_paper_bets
    (target_date, arm_hour, event_id, predicted_native_c, bucket_idx, label,
     ask, stake_usd, shares, fee_rate, running_max_c, forecast_c, placed_at)
  select
    (r->>'targetDate')::date, (r->>'armHour')::smallint, (r->>'eventId')::uuid,
    (r->>'predictedNativeC')::smallint, (r->>'bucketIdx')::smallint, r->>'label',
    (r->>'ask')::numeric, (r->>'stakeUsd')::numeric, (r->>'shares')::numeric,
    (r->>'feeRate')::numeric, (r->>'runMaxC')::numeric, (r->>'forecastC')::numeric,
    coalesce((r->>'placedAt')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (target_date, arm_hour) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- dashboard read (now surfaces forecastC in the bet log + latest call) ----------------------------
create or replace function public.dash_amsterdam_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  with b as (
    select * from public.amsterdam_paper_bets
  ),
  equity as (
    select arm_hour, target_date, status, won, pnl_usd, ask, label, predicted_native_c, actual_native_c,
      sum(coalesce(pnl_usd, 0)) over (partition by arm_hour order by target_date
                                      rows between unbounded preceding and current row) as cum,
      row_number() over (partition by arm_hour, (status <> 'pending') order by target_date) as graded_rank
    from b
  ),
  arm_stats as (
    select arm_hour,
      count(*) as n_bets,
      count(*) filter (where status <> 'pending') as n_graded,
      count(*) filter (where status = 'pending')  as n_pending,
      count(*) filter (where status = 'won')       as n_won,
      sum(stake_usd) filter (where status <> 'pending') as staked_graded,
      coalesce(sum(pnl_usd), 0) as pnl,
      avg(ask) as avg_ask,
      avg((won)::int) filter (where status <> 'pending') as hit_rate,
      coalesce(sum(pnl_usd) filter (
        where status <> 'pending'
          and target_date <= (
            select min(t14) from (
              select target_date as t14 from b b2
              where b2.arm_hour = b.arm_hour and b2.status <> 'pending'
              order by target_date offset 13 limit 1
            ) q
          )
      ), coalesce(sum(pnl_usd) filter (where status <> 'pending'), 0)) as pnl_at_compare
    from b
    group by arm_hour
  ),
  latest_day as (
    select max(target_date) as d from b
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'config', jsonb_build_object('primaryHour', 15, 'armHours', jsonb_build_array(13, 14, 15, 16),
                                 'compareDays', 14, 'stakeUsd', 10),
    'coverage', (
      select jsonb_build_object(
        'firstDate', min(target_date), 'lastDate', max(target_date),
        'nDays', count(distinct target_date),
        'nGradedDays', count(distinct target_date) filter (where status <> 'pending'),
        'nPending', count(*) filter (where status = 'pending')
      ) from b
    ),
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', arm_hour,
        'nBets', n_bets, 'nGraded', n_graded, 'nPending', n_pending, 'nWon', n_won,
        'staked', staked_graded, 'pnl', pnl,
        'roi', case when coalesce(staked_graded, 0) > 0 then pnl / staked_graded end,
        'hitRate', hit_rate, 'avgAsk', avg_ask, 'pnlAtCompare', pnl_at_compare
      ) order by arm_hour), '[]'::jsonb) from arm_stats
    ),
    'leader', (
      select jsonb_build_object('hour', arm_hour, 'pnl', pnl, 'nGraded', n_graded)
      from arm_stats where n_graded > 0 order by pnl desc, arm_hour limit 1
    ),
    'equityByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object(
          'date', target_date, 'pnl', pnl_usd, 'cum', cum, 'status', status
        ) order by target_date) as series
        from equity group by arm_hour
      ) s
    ),
    'betLog', (
      select coalesce(jsonb_agg(row order by d desc, h desc), '[]'::jsonb) from (
        select target_date as d, arm_hour as h, jsonb_build_object(
          'date', target_date, 'hour', arm_hour, 'predictedC', predicted_native_c, 'label', label,
          'ask', ask, 'runMaxC', running_max_c, 'forecastC', forecast_c, 'status', status, 'won', won,
          'pnl', pnl_usd, 'actualC', actual_native_c
        ) as row
        from b order by target_date desc, arm_hour desc limit 120
      ) lg
    ),
    'latest', (
      select jsonb_build_object(
        'date', (select d from latest_day),
        'byHour', coalesce(jsonb_object_agg(arm_hour::text, jsonb_build_object(
          'predictedC', predicted_native_c, 'label', label, 'ask', ask, 'status', status,
          'won', won, 'pnl', pnl_usd, 'actualC', actual_native_c, 'runMaxC', running_max_c,
          'forecastC', forecast_c
        )), '{}'::jsonb)
      )
      from b where target_date = (select d from latest_day)
    )
  ) into v;

  return v;
end;
$$;

-- --- grants (create-or-replace preserves ACLs, but re-assert the post-0034 contract explicitly) ------
revoke all on function public.amsterdam_sim_place_inputs(date, timestamptz) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_place_inputs(date, timestamptz) to service_role;
revoke all on function public.amsterdam_sim_record(jsonb) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_record(jsonb) to service_role;
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;
