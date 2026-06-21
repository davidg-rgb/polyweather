-- 0047_amsterdam_nmodels_distinct.sql — fix tomorrow.nModels to count DISTINCT models, not captures.
--
-- Code-review follow-up to 0046 (sql-1). The tomorrow block computed `count(*)` over forecast_snapshots
-- lead-1 rows for the target day and surfaced it as `nModels`. But the natural key of forecast_snapshots is
-- (icao, model, target_date, lead_days, snapshot_slot) — a single model that captured BOTH the 10Z and 22Z
-- slots contributes two rows, so count(*) is the number of CAPTURES, not distinct models, and over-reports
-- (~2x) once both daily slots have landed. The avg(tmax_c) is unaffected (it is the intended capture-weighted
-- cross-model mean, identical to amsterdam_sim_place_inputs). Only the count is corrected here:
--   count(*)  ->  count(distinct fs.model)
-- Everything else is the 0046 body VERBATIM (create-or-replace; whole body re-stated as required). Signature
-- unchanged (operator-authenticated read); no table changes.

create or replace function public.dash_amsterdam_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_today    date    := (now() at time zone 'Etc/GMT-2')::date;
  v_tmrw     date    := (now() at time zone 'Etc/GMT-2')::date + 1;
  v_t_event  uuid;
  v_t_raw    numeric;   -- cross-model lead-1 mean for tomorrow (°C), uncorrected
  v_t_nmod   int;       -- DISTINCT models behind the mean (0047 — was count(*) captures in 0046)
  v_t_bias   numeric;   -- trailing-30 mean(actual − forecast) residual
  v_t_bias_n int;       -- pairs behind the bias (<= 30)
  v_t_fc     numeric;   -- displayed forecast: corrected when >= 20 pairs, else raw
  v_t_corr   boolean;   -- whether the bias correction was applied
  v_t_pred   int;       -- wuRound(v_t_fc) — the whole-°C call
  v_t_bid    uuid;      -- ladder bucket id containing v_t_pred (tomorrow's market)
  v_t_label  text;      -- that bucket's label
  v_t_ask    numeric;   -- latest best_ask on that bucket
  v_tomorrow jsonb;
  v_live     jsonb;
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
      count(*) filter (where truth_won is not null)  as n_truth,
      count(*) filter (where truth_won is true)      as n_truth_won,
      avg((truth_won)::int) filter (where truth_won is not null) as truth_hit_rate,
      avg(abs(signed_error_c)) filter (where signed_error_c is not null) as mae,
      avg(signed_error_c) filter (where signed_error_c is not null)      as bias,
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
    'truthCoverage', (
      select jsonb_build_object(
        'nBetsWithTruth', count(*) filter (where truth_won is not null),
        'nDaysWithTruth', count(distinct target_date) filter (where actual_decimal_c is not null),
        'tableFirstDate', (select min(date_local) from public.amsterdam_truth),
        'tableLastDate',  (select max(date_local) from public.amsterdam_truth),
        'tableNDays',     (select count(*) from public.amsterdam_truth)
      ) from b
    ),
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', arm_hour,
        'nBets', n_bets, 'nGraded', n_graded, 'nPending', n_pending, 'nWon', n_won,
        'staked', staked_graded, 'pnl', pnl,
        'roi', case when coalesce(staked_graded, 0) > 0 then pnl / staked_graded end,
        'hitRate', hit_rate, 'avgAsk', avg_ask, 'pnlAtCompare', pnl_at_compare,
        'nTruth', n_truth, 'nTruthWon', n_truth_won, 'truthHitRate', truth_hit_rate,
        'mae', mae, 'bias', bias
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
    'betsByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object('won', won, 'ask', ask) order by target_date) as series
        from b where status <> 'pending'
        group by arm_hour
      ) s
    ),
    'truthByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object('truthWon', truth_won, 'signedErrorC', signed_error_c)
                                   order by target_date) as series
        from b where truth_won is not null
        group by arm_hour
      ) s
    ),
    'betLog', (
      select coalesce(jsonb_agg(row order by d desc, h desc), '[]'::jsonb) from (
        select target_date as d, arm_hour as h, jsonb_build_object(
          'date', target_date, 'hour', arm_hour, 'predictedC', predicted_native_c, 'label', label,
          'ask', ask, 'runMaxC', running_max_c, 'forecastC', forecast_c, 'status', status, 'won', won,
          'pnl', pnl_usd, 'actualC', actual_native_c,
          'actualDecimalC', actual_decimal_c, 'signedErrorC', signed_error_c, 'truthWon', truth_won
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
          'forecastC', forecast_c,
          'actualDecimalC', actual_decimal_c, 'signedErrorC', signed_error_c, 'truthWon', truth_won
        )), '{}'::jsonb)
      )
      from b where target_date = (select d from latest_day)
    )
  ) into v;

  -- ── tomorrow's prediction (0046) — nModels now DISTINCT models (0047) ────────────────────────────────
  select avg(fs.tmax_c), count(distinct fs.model)
    into v_t_raw, v_t_nmod
  from public.forecast_snapshots fs
  where fs.icao = 'EHAM' and fs.target_date = v_tmrw and fs.lead_days = 1;

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
      and o.date_local < v_tmrw
    order by o.date_local desc
    limit 30
  )
  select avg(resid), count(*) into v_t_bias, v_t_bias_n from pairs;

  v_t_corr := (v_t_raw is not null and coalesce(v_t_bias_n, 0) >= 20);
  v_t_fc   := case when v_t_raw is null then null
                   when v_t_corr then v_t_raw + coalesce(v_t_bias, 0)
                   else v_t_raw end;
  v_t_pred := case when v_t_fc is null then null else round(v_t_fc)::int end;   -- wuRound (half away from 0, +°C)

  select me.id into v_t_event
  from public.market_events me
  join public.cities c on c.id = me.city_id
  where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = v_tmrw
  order by me.created_at desc
  limit 1;

  if v_t_event is not null and v_t_pred is not null then
    select mb.id, mb.label into v_t_bid, v_t_label
    from public.market_buckets mb
    where mb.event_id = v_t_event
      and (mb.low_native  is null or v_t_pred >= mb.low_native)
      and (mb.high_native is null or v_t_pred <= mb.high_native)
    order by mb.bucket_idx
    limit 1;

    if v_t_bid is not null then
      select ms.best_ask into v_t_ask
      from public.market_snapshots ms
      where ms.bucket_id = v_t_bid and ms.best_ask is not null
      order by ms.captured_at desc
      limit 1;
    end if;
  end if;

  v_tomorrow := jsonb_build_object(
    'targetDate',    v_tmrw,
    'hasMarket',     (v_t_event is not null),
    'nModels',       v_t_nmod,
    'rawForecastC',  v_t_raw,
    'biasC',         v_t_bias,
    'biasN',         coalesce(v_t_bias_n, 0),
    'biasCorrected', v_t_corr,
    'forecastC',     v_t_fc,
    'predictedC',    v_t_pred,
    'label',         v_t_label,
    'ask',           v_t_ask
  );

  -- ── live running max as of now (0046) ────────────────────────────────────────────────────────────────
  select jsonb_build_object(
    'date',       im.date_local,
    'maxTenthsC', im.max_tenths_c,
    'maxNative',  im.max_native,
    'nObs',       im.n_obs,
    'lastObsAt',  im.last_obs_at
  ) into v_live
  from public.intraday_max im
  where im.icao = 'EHAM' and im.date_local = v_today;

  v := v || jsonb_build_object('tomorrow', v_tomorrow, 'liveRunMax', v_live);

  return v;
end;
$$;

-- create-or-replace preserves grants; re-assert the post-0034 contract explicitly.
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;
